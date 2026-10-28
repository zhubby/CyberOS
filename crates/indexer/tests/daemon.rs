mod common;

use cyberos_indexer::db::Db;

#[tokio::test]
async fn coalesced_queue_tasks_are_claimed_with_a_lease() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    let db = Db::open(&database).unwrap();
    db.enqueue("local", None, "docs", true, "incremental", 50)
        .await
        .unwrap();
    db.enqueue("local", None, "docs", true, "manual", 100)
        .await
        .unwrap();
    let task = db.claim("worker-1").await.unwrap().unwrap();
    assert_eq!(task.kind, "manual");
    assert_eq!(task.generation, 2);
    assert!(
        db.renew_lease(&task.id, task.generation, "worker-1")
            .await
            .unwrap()
    );
}
