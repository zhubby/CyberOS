use sigmaos_indexer::watcher::merge_ancestor;

#[test]
fn debounce_path_set_collapses_descendants() {
    let mut paths = Vec::new();
    merge_ancestor(&mut paths, "docs/a.txt".to_owned());
    merge_ancestor(&mut paths, "docs/b.txt".to_owned());
    merge_ancestor(&mut paths, "docs".to_owned());
    assert_eq!(paths, vec!["docs"]);
}
