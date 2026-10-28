mod common;

use std::path::Path;

use cyberos_indexer::db::Db;
use cyberos_indexer::media::run_media_scan;
use rusqlite::{Connection, params};
use tokio_util::sync::CancellationToken;

fn queue_scan(database: &Path, source_path: &str, scan_id: &str, generation: &str) {
    let connection = Connection::open(database).unwrap();
    connection
        .execute(
            "INSERT OR IGNORE INTO media_sources (
           id, name, kind, root_id, storage_pool_id, path, enabled, created_at, updated_at
         ) VALUES ('movies', 'Movies', 'movie', 'local', 'pool-1', ?, 1, 'now', 'now')",
            [source_path],
        )
        .unwrap();
    connection.execute(
        "INSERT INTO media_scan_runs (id, source_id, status, generation, created_at, updated_at) \
         VALUES (?, 'movies', 'queued', ?, 'now', 'now')",
        params![scan_id, generation],
    ).unwrap();
}

async fn claim_and_run(db: &Db, worker: &str) -> Result<(), cyberos_indexer::error::IndexerError> {
    let task = db.claim_media_scan(worker).await.unwrap().unwrap();
    run_media_scan(db, &task, worker, &CancellationToken::new()).await
}

#[tokio::test]
async fn scan_prefers_nfo_and_ignores_symlinked_media() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let movies = root.join("Movies/Arrival (2016)");
    std::fs::create_dir_all(&movies).unwrap();
    std::fs::write(movies.join("Arrival.2016.mkv"), b"video").unwrap();
    std::fs::write(
        movies.join("movie.nfo"),
        r#"<movie><title>降临</title><originaltitle>Arrival</originaltitle><year>2016</year><plot>本地简介</plot><uniqueid type="tmdb">329865</uniqueid></movie>"#,
    ).unwrap();
    std::fs::write(movies.join("poster.jpg"), b"image").unwrap();
    let outside = directory.path().join("outside.mkv");
    std::fs::write(&outside, b"outside").unwrap();
    symlink(&outside, movies.join("linked.mkv")).unwrap();

    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    queue_scan(&database, "Movies", "scan-1", "generation-1");
    let db = Db::open(&database).unwrap();
    claim_and_run(&db, "media-worker").await.unwrap();

    let connection = Connection::open(&database).unwrap();
    let title = connection
        .query_row(
            "SELECT title, original_title, year, metadata_source, match_status, tmdb_id \
         FROM media_titles WHERE source_id = 'movies'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        title,
        (
            "降临".to_owned(),
            "Arrival".to_owned(),
            2016,
            "nfo".to_owned(),
            "matched".to_owned(),
            329865
        )
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM media_files", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM media_artwork WHERE source = 'local'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn successful_generation_removes_stale_files() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let movies = root.join("Movies");
    std::fs::create_dir_all(&movies).unwrap();
    std::fs::write(movies.join("First.2020.mkv"), b"first").unwrap();
    std::fs::write(movies.join("Second.2021.mkv"), b"second").unwrap();
    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    queue_scan(&database, "Movies", "scan-1", "generation-1");
    let db = Db::open(&database).unwrap();
    claim_and_run(&db, "media-worker").await.unwrap();

    std::fs::remove_file(movies.join("Second.2021.mkv")).unwrap();
    queue_scan(&database, "Movies", "scan-2", "generation-2");
    claim_and_run(&db, "media-worker").await.unwrap();

    let connection = Connection::open(&database).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM media_files", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT removed FROM media_scan_runs WHERE id = 'scan-2'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn failed_scan_preserves_the_previous_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let movies = root.join("Movies");
    std::fs::create_dir_all(&movies).unwrap();
    std::fs::write(movies.join("Stable.2022.mkv"), b"stable").unwrap();
    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    queue_scan(&database, "Movies", "scan-1", "generation-1");
    let db = Db::open(&database).unwrap();
    claim_and_run(&db, "media-worker").await.unwrap();

    std::fs::rename(&movies, root.join("Movies-offline")).unwrap();
    queue_scan(&database, "Movies", "scan-2", "generation-2");
    assert!(claim_and_run(&db, "media-worker").await.is_err());

    let connection = Connection::open(&database).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM media_files", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT scan_generation FROM media_files", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "generation-1"
    );
}
