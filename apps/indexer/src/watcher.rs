use std::path::{Path, PathBuf};

use notify::event::{MetadataKind, ModifyKind};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::db::Root;
use crate::error::{ErrorCode, IndexerError};
use crate::scanner::is_ignored_path;

#[derive(Debug)]
pub enum WatchMessage {
    Changed {
        root_id: String,
        path: String,
    },
    Degraded {
        root_ids: Vec<String>,
        reason: String,
    },
}

pub fn start(
    roots: &[Root],
    sender: mpsc::UnboundedSender<WatchMessage>,
) -> Result<RecommendedWatcher, IndexerError> {
    let scopes: Vec<(String, PathBuf)> = roots
        .iter()
        .map(|root| (root.id.clone(), PathBuf::from(&root.path)))
        .collect();
    let callback_scopes = scopes.clone();
    let callback_sender = sender.clone();
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event) if should_enqueue(&event.kind) => {
                for event_path in event.paths {
                    if let Some((root_id, path)) = changed_path(&callback_scopes, &event_path) {
                        let _ = callback_sender.send(WatchMessage::Changed { root_id, path });
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                let root_ids = degraded_root_ids(&callback_scopes, &error);
                if !root_ids.is_empty() {
                    let _ = callback_sender.send(WatchMessage::Degraded {
                        root_ids,
                        reason: error.to_string(),
                    });
                }
            }
        })
        .map_err(|error| IndexerError::new(ErrorCode::Watcher, error.to_string(), true))?;

    for (root_id, root_path) in scopes {
        if let Err(error) = watcher.watch(&root_path, RecursiveMode::Recursive) {
            let root_scope = [(root_id, root_path)];
            let root_ids = degraded_root_ids(&root_scope, &error);
            if !root_ids.is_empty() {
                let _ = sender.send(WatchMessage::Degraded {
                    root_ids,
                    reason: error.to_string(),
                });
            }
        }
    }
    Ok(watcher)
}

fn should_enqueue(kind: &EventKind) -> bool {
    !matches!(
        kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))
    )
}

fn best_scope<'a>(scopes: &'a [(String, PathBuf)], path: &Path) -> Option<&'a (String, PathBuf)> {
    scopes
        .iter()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
}

fn changed_path(scopes: &[(String, PathBuf)], path: &Path) -> Option<(String, String)> {
    let (root_id, root_path) = best_scope(scopes, path)?;
    let relative_path = path.strip_prefix(root_path).ok()?;
    if is_ignored_path(relative_path) {
        return None;
    }
    Some((root_id.clone(), normalize_path(relative_path)))
}

fn degraded_root_ids(scopes: &[(String, PathBuf)], error: &notify::Error) -> Vec<String> {
    if error.paths.is_empty() {
        return scopes.iter().map(|(id, _)| id.clone()).collect();
    }

    let mut root_ids = Vec::new();
    for path in &error.paths {
        let Some((root_id, root_path)) = best_scope(scopes, path) else {
            return scopes.iter().map(|(id, _)| id.clone()).collect();
        };
        let relative_path = path
            .strip_prefix(root_path)
            .unwrap_or_else(|_| Path::new("."));
        if !is_ignored_path(relative_path) && !root_ids.contains(root_id) {
            root_ids.push(root_id.clone());
        }
    }
    root_ids
}

fn normalize_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        ".".to_owned()
    } else {
        value
    }
}

pub fn merge_ancestor(paths: &mut Vec<String>, candidate: String) {
    if paths
        .iter()
        .any(|existing| is_same_or_ancestor(existing, &candidate))
    {
        return;
    }
    paths.retain(|existing| !is_same_or_ancestor(&candidate, existing));
    paths.push(candidate);
    paths.sort();
}

fn is_same_or_ancestor(ancestor: &str, path: &str) -> bool {
    ancestor == "."
        || ancestor == path
        || path
            .strip_prefix(ancestor)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, RemoveKind};

    #[test]
    fn ignores_access_events_caused_by_indexing_reads() {
        assert!(!should_enqueue(&EventKind::Access(AccessKind::Any)));
        assert!(!should_enqueue(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!should_enqueue(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!should_enqueue(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(!should_enqueue(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::AccessTime
        ))));
        assert!(should_enqueue(&EventKind::Create(CreateKind::Any)));
        assert!(should_enqueue(&EventKind::Modify(ModifyKind::Any)));
        assert!(should_enqueue(&EventKind::Remove(RemoveKind::Any)));
    }

    #[test]
    fn merges_descendants_into_their_nearest_ancestor() {
        let mut paths = vec!["docs/a.txt".to_owned(), "media/x.jpg".to_owned()];
        merge_ancestor(&mut paths, "docs".to_owned());
        merge_ancestor(&mut paths, "docs/b.txt".to_owned());
        assert_eq!(paths, vec!["docs", "media/x.jpg"]);
        merge_ancestor(&mut paths, ".".to_owned());
        assert_eq!(paths, vec!["."]);
    }

    #[test]
    fn ignores_watcher_errors_below_ignored_directories() {
        let scopes = [(
            "primary".to_owned(),
            PathBuf::from("/zos/data/primary/pool1"),
        )];
        let error = notify::Error::io(io::Error::from(io::ErrorKind::PermissionDenied))
            .add_path(PathBuf::from("/zos/data/primary/pool1/.zos"));

        assert!(degraded_root_ids(&scopes, &error).is_empty());
    }

    #[test]
    fn degrades_the_affected_root_for_other_watcher_errors() {
        let scopes = [
            (
                "primary".to_owned(),
                PathBuf::from("/zos/data/primary/pool1"),
            ),
            ("backup".to_owned(), PathBuf::from("/zos/data/backup/pool1")),
        ];
        let error = notify::Error::io(io::Error::from(io::ErrorKind::PermissionDenied))
            .add_path(PathBuf::from("/zos/data/primary/pool1/private"));

        assert_eq!(degraded_root_ids(&scopes, &error), vec!["primary"]);
    }

    #[test]
    fn ignores_events_below_ignored_directories() {
        let scopes = [(
            "primary".to_owned(),
            PathBuf::from("/zos/data/primary/pool1"),
        )];

        assert_eq!(
            changed_path(
                &scopes,
                Path::new("/zos/data/primary/pool1/.zos/cold-backup.json")
            ),
            None
        );
        assert_eq!(
            changed_path(
                &scopes,
                Path::new("/zos/data/primary/pool1/documents/report.txt")
            ),
            Some(("primary".to_owned(), "documents/report.txt".to_owned()))
        );
    }
}
