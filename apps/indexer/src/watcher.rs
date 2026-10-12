use std::path::{Path, PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::db::Root;
use crate::error::{ErrorCode, IndexerError};

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
            Ok(event) => {
                for event_path in event.paths {
                    if let Some((root_id, root_path)) = best_scope(&callback_scopes, &event_path) {
                        let relative = event_path
                            .strip_prefix(root_path)
                            .ok()
                            .map(normalize_path)
                            .unwrap_or_else(|| ".".to_owned());
                        let _ = callback_sender.send(WatchMessage::Changed {
                            root_id: root_id.clone(),
                            path: relative,
                        });
                    }
                }
            }
            Err(error) => {
                let root_ids = callback_scopes.iter().map(|(id, _)| id.clone()).collect();
                let _ = callback_sender.send(WatchMessage::Degraded {
                    root_ids,
                    reason: error.to_string(),
                });
            }
        })
        .map_err(|error| IndexerError::new(ErrorCode::Watcher, error.to_string(), true))?;

    for (root_id, root_path) in scopes {
        if let Err(error) = watcher.watch(&root_path, RecursiveMode::Recursive) {
            let _ = sender.send(WatchMessage::Degraded {
                root_ids: vec![root_id],
                reason: error.to_string(),
            });
        }
    }
    Ok(watcher)
}

fn best_scope<'a>(scopes: &'a [(String, PathBuf)], path: &Path) -> Option<&'a (String, PathBuf)> {
    scopes
        .iter()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
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
    use super::*;

    #[test]
    fn merges_descendants_into_their_nearest_ancestor() {
        let mut paths = vec!["docs/a.txt".to_owned(), "media/x.jpg".to_owned()];
        merge_ancestor(&mut paths, "docs".to_owned());
        merge_ancestor(&mut paths, "docs/b.txt".to_owned());
        assert_eq!(paths, vec!["docs", "media/x.jpg"]);
        merge_ancestor(&mut paths, ".".to_owned());
        assert_eq!(paths, vec!["."]);
    }
}
