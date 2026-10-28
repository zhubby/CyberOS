use std::path::Path;

use cyberos_indexer::storage::{RootStorage, validate_relative_path};

#[test]
fn rejects_parent_paths_and_root_symlinks() {
    use std::os::unix::fs::symlink;

    assert!(validate_relative_path(Path::new("../outside")).is_err());
    let directory = tempfile::tempdir().unwrap();
    let real = directory.path().join("real");
    let link = directory.path().join("link");
    std::fs::create_dir(&real).unwrap();
    symlink(&real, &link).unwrap();
    assert!(RootStorage::open(&link).is_err());
}
