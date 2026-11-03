use super::tests::{full_schema, publish_record, seed_job, test_job};
use super::*;
use rusqlite::StatementStatus;

async fn fixture() -> (tempfile::TempDir, Db) {
    let temporary = tempfile::tempdir().unwrap();
    let db = Db::open(&temporary.path().join("db.sqlite")).unwrap();
    db.call(|connection| {
        full_schema(connection);
        seed_job(connection);
        connection
            .execute("DELETE FROM photos_scan_entries", [])
            .unwrap();
        Ok(())
    })
    .await
    .unwrap();
    (temporary, db)
}

#[tokio::test]
async fn indexed_sidecars_preserve_exact_raw_and_case_ambiguity_rules() {
    let (_temporary, db) = fixture().await;
    let names = [
        "coast.jpg",
        "coast.cr3",
        "coast.xmp",
        "coast.jpg.xmp",
        "solo.jpg",
        "solo.xmp",
        "SOLO.XMP",
        "nested/coast.jpg",
    ];
    db.add_scan_entries(
        "job-1",
        "Pictures",
        names
            .into_iter()
            .map(|name| DiscoveredEntry {
                path: format!("Pictures/{name}"),
                entry_type: if name.to_lowercase().ends_with(".xmp") {
                    "sidecar"
                } else {
                    "media"
                }
                .into(),
            })
            .collect(),
        "worker-1",
    )
    .await
    .unwrap();
    assert_eq!(
        db.indexed_sidecar_for("job-1", "Pictures/coast.jpg")
            .await
            .unwrap()
            .unwrap(),
        Some("Pictures/coast.jpg.xmp".into())
    );
    assert_eq!(
        db.indexed_sidecar_for("job-1", "Pictures/coast.cr3")
            .await
            .unwrap()
            .unwrap(),
        Some("Pictures/coast.xmp".into())
    );
    assert!(
        db.indexed_sidecar_for("job-1", "Pictures/solo.jpg")
            .await
            .unwrap()
            .is_err()
    );
    db.call(|connection| {
        connection
            .execute(
                "UPDATE photos_scan_entries SET name_key=NULL,stem_key=NULL,media_kind=NULL",
                [],
            )
            .unwrap();
        Ok(())
    })
    .await
    .unwrap();
    db.backfill_lookup_keys(&test_job(), "worker-1")
        .await
        .unwrap();
    assert_eq!(
        db.indexed_sidecar_for("job-1", "Pictures/coast.cr3")
            .await
            .unwrap()
            .unwrap(),
        Some("Pictures/coast.xmp".into())
    );
}

#[tokio::test]
async fn batched_completion_is_idempotent_and_fenced_and_directory_work_resumes() {
    let (_temporary, db) = fixture().await;
    let job = test_job();
    db.initialize_scan(&job, "worker-1").await.unwrap();
    db.add_scan_entries(
        &job.id,
        "Pictures",
        vec![DiscoveredEntry {
            path: "Pictures/a.jpg".into(),
            entry_type: "media".into(),
        }],
        "worker-1",
    )
    .await
    .unwrap();
    db.claim_entry(&job.id, "directory", "worker-1")
        .await
        .unwrap();
    db.complete_entry(&job.id, "Pictures", false, "worker-1")
        .await
        .unwrap();
    assert_eq!(
        db.completed_directory(&job, "worker-1")
            .await
            .unwrap()
            .as_deref(),
        Some("Pictures")
    );
    assert!(
        db.finish_directory(&job, "Pictures", "worker-1")
            .await
            .is_err()
    );
    let entries = db
        .claim_media_batch(&job, "Pictures", "worker-1")
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert!(
        db.complete_unchanged_batch(&job, vec![entries[0].path.clone()], "stale-worker")
            .await
            .is_err()
    );
    for _ in 0..2 {
        db.complete_unchanged_batch(&job, vec![entries[0].path.clone()], "worker-1")
            .await
            .unwrap();
    }
    db.finish_directory(&job, "Pictures", "worker-1")
        .await
        .unwrap();
    assert!(
        db.completed_directory(&job, "worker-1")
            .await
            .unwrap()
            .is_none()
    );
    db.call(|connection| {
        assert_eq!(
            connection
                .query_row("SELECT scanned,processed FROM photos_jobs", [], |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?
                )))
                .unwrap(),
            (2, 1)
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn local_cleanup_respects_pool_version_and_literal_directory_boundaries() {
    let (_temporary, db) = fixture().await;
    let job = Job {
        kind: "path_refresh".into(),
        path: "Pictures/a_%".into(),
        ..test_job()
    };
    db.call(|connection| {
        connection.execute("INSERT INTO photos_scan_entries(job_id,path,entry_type,status,children_processed,updated_at) VALUES('job-1','Pictures/a_%','directory','completed',1,'2026')", []).unwrap();
        let transaction = connection.transaction().unwrap();
        for (id, pool, path, version) in [
            ("stale", "pool-1", "Pictures/a_%/old.jpg", "2026-10-11T00:00:00Z"),
            ("sibling", "pool-1", "Pictures/a_%s/old.jpg", "2026-10-11T00:00:00Z"),
            ("wildcard", "pool-1", "Pictures/abc/old.jpg", "2026-10-11T00:00:00Z"),
            ("other-pool", "pool-2", "Pictures/a_%/old.jpg", "2026-10-11T00:00:00Z"),
            ("other-version", "pool-1", "Pictures/a_%/other.jpg", "old-version"),
        ] {
            let mut record = publish_record();
            record.asset_id=id.into(); record.storage_pool_id=pool.into(); record.path=path.into(); record.library_updated_at=version.into();
            record.scan_generation="old-generation".into();
            write_record(&transaction, &record).unwrap();
        }
        transaction.commit().unwrap(); Ok(())
    }).await.unwrap();
    db.finish_job(&job, "worker-1").await.unwrap();
    db.call(|connection| {
        let ids = connection
            .prepare("SELECT id FROM photos_assets ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, ["other-pool", "other-version", "sibling", "wildcard"]);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn history_cleanup_is_bounded_and_keeps_active_and_journal_jobs() {
    let (_temporary, db) = fixture().await;
    db.call(|connection| {
        for (id,status,finished) in [("done","completed","2020"),("old-failed","failed","2020"),("recent-failed","failed","9999"),("journal","completed","2020"),("retry","retrying","2020")] {
            connection.execute("INSERT INTO photos_jobs(id,kind,status,storage_pool_id,path,library_updated_at,scan_generation,created_at,updated_at,finished_at) VALUES(?,'full_scan',?,'pool-1','Pictures','old',?,'2020','2020',?)",params![id,status,id,finished]).unwrap();
            connection.execute("INSERT INTO photos_scan_entries(job_id,path,entry_type,status,updated_at) VALUES(?,'Pictures/keep.jpg','media','completed','2020')", [id]).unwrap();
        }
        connection.execute("INSERT INTO photos_publish_journal(operation_id,job_id,asset_id,source_path,source_device,source_inode,source_size_bytes,result_json,created_at) VALUES('op','journal','asset','Pictures/keep.jpg',1,1,1,'{}','2020')",[]).unwrap();
        let transaction=connection.transaction().unwrap();
        for i in 0..1100 { transaction.execute("INSERT INTO photos_scan_entries(job_id,path,entry_type,status,updated_at) VALUES('done',?,'media','completed','2020')",[format!("Pictures/{i}.jpg")]).unwrap(); }
        transaction.commit().unwrap(); Ok(())
    }).await.unwrap();
    assert_eq!(db.prune_history_batch().await.unwrap(), 1000);
    while db.prune_history_batch().await.unwrap() != 0 {}
    db.call(|connection| {
        let jobs = connection
            .prepare("SELECT id FROM photos_jobs ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(jobs, ["job-1", "journal", "recent-failed", "retry"]);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM photos_scan_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[test]
fn scheduling_sql_work_scales_linearly_for_ten_and_hundred_thousand_photos() {
    let mut totals = Vec::new();
    for size in [10_000, 100_000] {
        let mut connection = Connection::open_in_memory().unwrap();
        full_schema(&connection);
        seed_job(&connection);
        connection
            .execute("DELETE FROM photos_scan_entries", [])
            .unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut insert=transaction.prepare_cached("INSERT INTO photos_scan_entries(job_id,path,parent_path,entry_type,status,name_key,stem_key,media_kind,updated_at) VALUES('job-1',?,'Pictures',?,?,?,?,?,'2026')").unwrap();
            for i in 0..size {
                let stem = format!("{i:06}");
                insert
                    .execute(params![
                        format!("Pictures/{stem}.jpg"),
                        "media",
                        "pending",
                        format!("{stem}.jpg"),
                        stem,
                        "image"
                    ])
                    .unwrap();
                insert
                    .execute(params![
                        format!("Pictures/{stem}.jpg.xmp"),
                        "sidecar",
                        "completed",
                        format!("{stem}.jpg.xmp"),
                        format!("{stem}.jpg"),
                        None::<String>
                    ])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
        let transaction = connection.transaction().unwrap();
        let mut total = 0i64;
        {
            let mut pending = transaction.prepare(scan::MEDIA_PENDING_SQL).unwrap();
            let mut sidecar = transaction.prepare(scan::SIDECAR_SQL).unwrap();
            let mut complete=transaction.prepare("UPDATE photos_scan_entries SET status='completed' WHERE job_id='job-1' AND path=?").unwrap();
            for i in 0..size {
                let path: String = pending
                    .query_row(params!["job-1", "Pictures", now_iso(), 1], |row| row.get(0))
                    .unwrap();
                let claim_steps = pending.reset_status(StatementStatus::VmStep);
                assert!(
                    claim_steps < 100,
                    "{size} photos at {i}: {claim_steps} claim steps"
                );
                let name = Path::new(&path).file_name().unwrap().to_str().unwrap();
                let found: String = sidecar
                    .query_row(params!["job-1", "Pictures", format!("{name}.xmp")], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(found, format!("{path}.xmp"));
                let sidecar_steps = sidecar.reset_status(StatementStatus::VmStep);
                assert!(sidecar_steps < 100);
                complete.execute([path]).unwrap();
                total += i64::from(
                    claim_steps + sidecar_steps + complete.reset_status(StatementStatus::VmStep),
                );
            }
            let mut retry = transaction.prepare(scan::MEDIA_RETRY_SQL).unwrap();
            assert!(
                retry
                    .query_row(params!["job-1", "Pictures", now_iso(), 1], |_| Ok(()))
                    .optional()
                    .unwrap()
                    .is_none()
            );
            assert!(retry.get_status(StatementStatus::VmStep) < 100);
        }
        transaction.commit().unwrap();
        eprintln!("Photos scheduling scale: {size} media + {size} XMP, {total} SQLite VM steps");
        totals.push(total);
    }
    assert!(totals[1] <= totals[0] * 15);
}

#[tokio::test]
async fn incomplete_traversal_and_lost_leases_cannot_clean_assets() {
    let (_temporary, db) = fixture().await;
    let job = test_job();
    db.initialize_scan(&job, "worker-1").await.unwrap();
    db.call(|connection| {
        let transaction = connection.transaction().unwrap();
        let mut record = publish_record();
        record.scan_generation = "old".into();
        write_record(&transaction, &record).unwrap();
        transaction.commit().unwrap();
        Ok(())
    })
    .await
    .unwrap();
    assert!(db.finish_job(&job, "worker-1").await.is_err());
    db.claim_entry(&job.id, "directory", "worker-1")
        .await
        .unwrap();
    db.complete_entry(&job.id, &job.path, false, "worker-1")
        .await
        .unwrap();
    assert!(db.finish_job(&job, "worker-1").await.is_err());
    db.finish_directory(&job, &job.path, "worker-1")
        .await
        .unwrap();
    assert!(db.finish_job(&job, "stale-worker").await.is_err());
    db.call(|connection| {
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM photos_assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cleanup_preserves_current_latest_and_last_successful_full_scan_summaries() {
    let (_temporary, db) = fixture().await;
    db.call(|connection| {
        for (id,kind,status,created) in [("last-success","full_scan","completed","2020"),("latest","path_refresh","failed","9999")] {
            connection.execute("INSERT INTO photos_jobs(id,kind,status,storage_pool_id,path,library_updated_at,scan_generation,created_at,updated_at,finished_at) VALUES(?,?,?,'pool-1','Pictures','2026-10-11T00:00:00Z',?,?,'2020','2020')",params![id,kind,status,id,created]).unwrap();
        }
        Ok(())
    }).await.unwrap();
    assert_eq!(db.prune_history_batch().await.unwrap(), 0);
    db.call(|connection| {
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM photos_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn journal_recovery_discards_old_library_publications() {
    let (_temporary, db) = fixture().await;
    db.call(|connection| {
        let record=publish_record();
        connection.execute("INSERT INTO photos_publish_journal(operation_id,job_id,asset_id,source_path,source_device,source_inode,source_size_bytes,result_json,created_at) VALUES('operation-1','job-1','asset-1','Pictures/coast.jpg',1,1,1,'{}','2026')",[]).unwrap();
        connection.execute("UPDATE photos_jobs SET status='failed',worker_id=NULL,lease_expires_at=NULL",[]).unwrap();
        connection.execute("UPDATE system_settings SET value_json=? WHERE key='photos_library_settings'",[r#"{"storagePoolId":"pool-2","path":"Pictures","updatedAt":"new-version"}"#]).unwrap();
        assert!(!complete_publish_transaction(connection,&record,None).unwrap());
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM photos_assets",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM photos_publish_journal",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        Ok(())
    }).await.unwrap();
}
