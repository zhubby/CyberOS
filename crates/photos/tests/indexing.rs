use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};

struct Harness {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    db: Connection,
    child: Child,
}

impl Harness {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().to_owned();
        for directory in ["state", "data/pool-1/Pictures", "tools"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        let db = Connection::open(root.join("state/cyberos.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT); INSERT INTO schema_migrations VALUES('008_photos_index_performance','2026');").unwrap();
        for source in [
            include_str!("../../../packages/db/src/migrations/current.ts"),
            include_str!("../../../packages/db/src/migrations/photos-scan-contention.ts"),
            include_str!("../../../packages/db/src/migrations/photos-index-performance.ts"),
        ] {
            db.execute_batch(
                source
                    .split("sql: `")
                    .nth(1)
                    .unwrap()
                    .split('`')
                    .next()
                    .unwrap(),
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO system_settings VALUES('photos_library_settings',?, '2026')",
            [r#"{"storagePoolId":"pool-1","path":"Pictures","updatedAt":"2026"}"#],
        )
        .unwrap();
        let script = r#"#!/bin/sh
PHOTO_TEST_ROOT="$(dirname "$0")/.."
case "${0##*/}" in
exiftool)
  content=$(cat /dev/fd/198)
  if [ "$content" = 'HOLD' ]; then
    while [ -f "$PHOTO_TEST_ROOT/pause" ]; do sleep 0.05; done
  fi
  case "$content" in
    SIDE*) printf '[{"XMP:Title":"%s"}]' "$content" ;;
    *) printf '[{"File:MIMEType":"image/jpeg","File:ImageWidth":32,"File:ImageHeight":24}]' ;;
  esac ;;
vipsthumbnail)
  printf 'render\n' >> "$PHOTO_TEST_ROOT/renders"
  if [ -f "$PHOTO_TEST_ROOT/collapse-archive" ]; then
    rmdir "$PHOTO_TEST_ROOT/data/pool-1/Pictures/archive"
    printf 'replaced' > "$PHOTO_TEST_ROOT/data/pool-1/Pictures/archive"
    rm "$PHOTO_TEST_ROOT/collapse-archive"
  fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = '--output' ]; then shift; target=${1%%\[*}; printf 'derivative' > "$target"; exit 0; fi
    shift
  done
  exit 2 ;;
vipsheader) exit 0 ;;
*) exit 0 ;;
esac
"#;
        for name in [
            "exiftool",
            "vipsthumbnail",
            "vipsheader",
            "ffprobe",
            "ffmpeg",
            "dcraw_emu",
            "heif-convert",
        ] {
            let path = root.join("tools").join(name);
            fs::write(
                &path,
                script.replace("/dev/fd/198", cyberos_photos::command::child_media_path()),
            )
            .unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let child = Self::spawn(&root);
        Self {
            _temporary: temporary,
            root,
            db,
            child,
        }
    }

    fn spawn(root: &Path) -> Child {
        Command::new(env!("CARGO_BIN_EXE_cyberos-photos"))
            .env("CYBEROS_ROOT", root)
            .env("CYBEROS_ENVIRONMENT", "development")
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", root.join("tools").display()),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn wait_until(&mut self, condition: impl Fn(&Connection) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !condition(&self.db) {
            assert!(self.child.try_wait().unwrap().is_none(), "worker exited");
            assert!(
                Instant::now() < deadline,
                "worker did not reach expected checkpoint"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn media(&self, name: &str, contents: &str) {
        fs::write(self.root.join("data/pool-1/Pictures").join(name), contents).unwrap();
    }

    fn enqueue(&self, id: &str, kind: &str, path: &str) {
        self.db.execute("INSERT INTO photos_jobs(id,kind,status,storage_pool_id,path,library_updated_at,scan_generation,created_at,updated_at) VALUES(?,?,'queued','pool-1',?,'2026',?,datetime('now'),datetime('now'))", params![id,kind,path,id]).unwrap();
    }

    fn wait_job(&mut self, id: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(self.child.try_wait().unwrap().is_none(), "worker exited");
            let state: String = self
                .db
                .query_row("SELECT status FROM photos_jobs WHERE id=?", [id], |row| {
                    row.get(0)
                })
                .unwrap();
            if ["completed", "failed"].contains(&state.as_str()) {
                return state;
            }
            let error: Option<String> = self
                .db
                .query_row("SELECT error FROM photos_jobs WHERE id=?", [id], |row| {
                    row.get(0)
                })
                .unwrap();
            assert!(
                Instant::now() < deadline,
                "job {id} did not complete ({state}): {error:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn thumbnail(&self) -> PathBuf {
        self.root.join("state/photos").join(
            self.db
                .query_row(
                    "SELECT thumbnail_key FROM photos_assets WHERE path='Pictures/a.jpg'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn publishes_a_completed_directory_before_discovering_a_failing_descendant() {
    let mut h = Harness::new();
    h.media("a.jpg", "photo");
    fs::create_dir(h.root.join("data/pool-1/Pictures/archive")).unwrap();
    fs::write(h.root.join("collapse-archive"), "1").unwrap();
    h.enqueue("first", "full_scan", "Pictures");
    assert_eq!(h.wait_job("first"), "failed");
    assert_eq!(
        h.db.query_row(
            "SELECT COUNT(*) FROM photos_assets WHERE status='ready'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn xmp_refresh_preserves_derivatives_and_missing_cache_is_repaired() {
    let mut h = Harness::new();
    h.media("a.jpg", "photo");
    h.media("a.jpg.xmp", "SIDE-one");
    h.enqueue("first", "full_scan", "Pictures");
    assert_eq!(h.wait_job("first"), "completed");
    let thumbnail = h.thumbnail();
    let before = fs::metadata(&thumbnail).unwrap().modified().unwrap();
    let renders = fs::read_to_string(h.root.join("renders")).unwrap();
    h.media("a.jpg.xmp", "SIDE-two");
    h.enqueue("second", "path_refresh", "Pictures");
    assert_eq!(h.wait_job("second"), "completed");
    assert_eq!(
        fs::metadata(&thumbnail).unwrap().modified().unwrap(),
        before
    );
    assert_eq!(fs::read_to_string(h.root.join("renders")).unwrap(), renders);
    assert_eq!(
        h.db.query_row("SELECT title FROM photos_asset_metadata", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "SIDE-two"
    );
    fs::remove_file(&thumbnail).unwrap();
    h.enqueue("third", "path_refresh", "Pictures");
    assert_eq!(h.wait_job("third"), "completed");
    assert!(Path::new(&thumbnail).is_file());
}

#[test]
fn changes_during_processing_are_indexed_by_the_followup_refresh() {
    let mut h = Harness::new();
    h.media("a.jpg", "HOLD");
    fs::write(h.root.join("pause"), "1").unwrap();
    h.enqueue("first", "full_scan", "Pictures");
    h.wait_until(|db| db.query_row("SELECT COUNT(*) FROM photos_scan_entries WHERE job_id='first' AND entry_type='media' AND status='processing'",[],|row|row.get::<_,i64>(0)).unwrap()==1);
    h.media("new.jpg", "new photo");
    h.enqueue("second", "path_refresh", "Pictures");
    fs::remove_file(h.root.join("pause")).unwrap();
    assert_eq!(h.wait_job("first"), "completed");
    assert_eq!(h.wait_job("second"), "completed");
    assert_eq!(
        h.db.query_row(
            "SELECT COUNT(*) FROM photos_assets WHERE status='ready'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        h.db.query_row(
            "SELECT scanned,processed FROM photos_jobs WHERE id='second'",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        )
        .unwrap(),
        (3, 2)
    );
}

#[test]
fn restart_resumes_the_directory_checkpoint_without_recounting_or_rendering_completed_media() {
    let mut h = Harness::new();
    h.media("a.jpg", "photo");
    fs::create_dir(h.root.join("data/pool-1/Pictures/archive")).unwrap();
    h.media("archive/b.jpg", "HOLD");
    fs::write(h.root.join("pause"), "1").unwrap();
    h.enqueue("first", "full_scan", "Pictures");
    h.wait_until(|db| db.query_row("SELECT COUNT(*) FROM photos_scan_entries WHERE path='Pictures/archive/b.jpg' AND status='processing'",[],|row|row.get::<_,i64>(0)).unwrap()==1);
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(h.child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    h.child.wait().unwrap();
    fs::remove_file(h.root.join("pause")).unwrap();
    h.child = Harness::spawn(&h.root);
    assert_eq!(h.wait_job("first"), "completed");
    assert_eq!(
        h.db.query_row(
            "SELECT scanned,processed FROM photos_jobs WHERE id='first'",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        )
        .unwrap(),
        (4, 2)
    );
    assert_eq!(
        fs::read_to_string(h.root.join("renders"))
            .unwrap()
            .lines()
            .count(),
        4
    );
}

#[test]
fn deleted_refresh_scope_falls_back_to_an_existing_ancestor_and_cleans_only_that_subtree() {
    let mut h = Harness::new();
    for directory in ["archive", "sibling"] {
        fs::create_dir(h.root.join("data/pool-1/Pictures").join(directory)).unwrap();
    }
    h.media("archive/a.jpg", "archive");
    h.media("sibling/b.jpg", "sibling");
    h.enqueue("first", "full_scan", "Pictures");
    assert_eq!(h.wait_job("first"), "completed");
    fs::remove_dir_all(h.root.join("data/pool-1/Pictures/archive")).unwrap();
    h.enqueue("second", "path_refresh", "Pictures/archive");
    assert_eq!(h.wait_job("second"), "completed");
    assert_eq!(
        h.db.query_row("SELECT path FROM photos_assets", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "Pictures/sibling/b.jpg"
    );
    assert_eq!(
        h.db.query_row(
            "SELECT path FROM photos_jobs WHERE id='second'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "Pictures"
    );
}

#[test]
fn pool_root_scans_and_local_refreshes_preserve_the_same_asset_id() {
    let mut h = Harness::new();
    h.db.execute(
        "UPDATE system_settings SET value_json=? WHERE key='photos_library_settings'",
        [r#"{"storagePoolId":"pool-1","path":".","updatedAt":"2026"}"#],
    )
    .unwrap();
    h.media("a.jpg", "photo");
    h.enqueue("first", "full_scan", ".");
    assert_eq!(h.wait_job("first"), "completed");
    let id: String =
        h.db.query_row("SELECT id FROM photos_assets", [], |row| row.get(0))
            .unwrap();
    h.enqueue("second", "path_refresh", "Pictures");
    assert_eq!(h.wait_job("second"), "completed");
    assert_eq!(
        h.db.query_row("SELECT id FROM photos_assets", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        id
    );
    assert_eq!(
        h.db.query_row("SELECT COUNT(*) FROM photos_assets", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
