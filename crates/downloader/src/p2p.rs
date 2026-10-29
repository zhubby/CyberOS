use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use crate::db::{Db, ResolvedTorrentPreview, Task, TorrentFile, TorrentPreview, TorrentProgress};
use crate::error::{DownloadError, ErrorCode};
use crate::storage::TorrentStorageTarget;

const TORRENT_LEASE: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_TORRENT_FILES: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentTaskOutcome {
    Complete,
    Interrupted,
    Shutdown,
}

pub struct TorrentRunContext<'a> {
    pub data_root: &'a Path,
    pub require_mount: bool,
    pub minimum_free_bytes: u64,
    pub shutdown: &'a tokio_util::sync::CancellationToken,
}

#[derive(Clone)]
pub struct TorrentEngine {
    session: Arc<librqbit::Session>,
}

impl TorrentEngine {
    pub async fn new(
        output_root: &Path,
        cancellation_token: tokio_util::sync::CancellationToken,
    ) -> Result<Self, DownloadError> {
        let options = librqbit::SessionOptions {
            dht: Some(librqbit::DhtSessionConfig {
                persistence: None,
                ..Default::default()
            }),
            listen: Some(librqbit::ListenerOptions {
                enable_upnp_port_forwarding: false,
                ..Default::default()
            }),
            persistence: None,
            fastresume: false,
            cancellation_token: Some(cancellation_token),
            client_name_and_version: Some(format!("CyberOS/{}", env!("CARGO_PKG_VERSION"))),
            ..Default::default()
        };
        Self::new_with_options(output_root, options).await
    }

    #[cfg(test)]
    async fn new_isolated(
        output_root: &Path,
        listen_address: Option<SocketAddr>,
    ) -> Result<Self, DownloadError> {
        let options = librqbit::SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            listen: listen_address.map(|listen_addr| librqbit::ListenerOptions {
                listen_addr,
                enable_upnp_port_forwarding: false,
                ipv4_only: true,
                ..Default::default()
            }),
            persistence: None,
            fastresume: false,
            ipv4_only: true,
            ..Default::default()
        };
        Self::new_with_options(output_root, options).await
    }

    async fn new_with_options(
        output_root: &Path,
        options: librqbit::SessionOptions,
    ) -> Result<Self, DownloadError> {
        let session = librqbit::Session::new_with_opts(output_root.to_path_buf(), options)
            .await
            .map_err(torrent_engine_error)?;
        Ok(Self { session })
    }

    pub async fn add_torrent_bytes(
        &self,
        metainfo: &[u8],
        selected_file_indices: &[usize],
        output_folder: &Path,
        initial_peers: Vec<SocketAddr>,
    ) -> Result<Arc<librqbit::ManagedTorrent>, DownloadError> {
        let response = self
            .session
            .add_torrent(
                librqbit::AddTorrent::from_bytes(metainfo.to_vec()),
                Some(librqbit::AddTorrentOptions {
                    only_files: Some(selected_file_indices.to_vec()),
                    overwrite: true,
                    output_folder: Some(output_folder.to_string_lossy().into_owned()),
                    initial_peers: (!initial_peers.is_empty()).then_some(initial_peers),
                    ..Default::default()
                }),
            )
            .await
            .map_err(torrent_engine_error)?;
        response.into_handle().ok_or_else(|| {
            DownloadError::new(
                ErrorCode::Internal,
                "torrent engine did not return a task handle",
                false,
            )
        })
    }

    pub async fn remove(
        &self,
        handle: &Arc<librqbit::ManagedTorrent>,
    ) -> Result<(), DownloadError> {
        self.session
            .delete(handle.id().into(), false)
            .await
            .map_err(torrent_engine_error)
    }

    pub async fn resolve_preview(
        &self,
        preview: &TorrentPreview,
    ) -> Result<ResolvedTorrentPreview, DownloadError> {
        let resolved = match preview.source_kind.as_str() {
            "torrent" => parse_torrent_preview(preview.metainfo.as_deref().ok_or_else(|| {
                DownloadError::new(
                    ErrorCode::TorrentInvalid,
                    "torrent preview has no metadata",
                    false,
                )
            })?)?,
            "magnet" => {
                let source = preview.source_uri.as_deref().ok_or_else(|| {
                    DownloadError::new(
                        ErrorCode::TorrentInvalid,
                        "magnet preview has no source",
                        false,
                    )
                })?;
                let magnet = librqbit::Magnet::parse(source).map_err(|error| {
                    DownloadError::new(ErrorCode::TorrentInvalid, error.to_string(), false)
                })?;
                for tracker in &magnet.trackers {
                    validate_tracker_network(tracker).await?;
                }
                let response = self
                    .session
                    .add_torrent(
                        librqbit::AddTorrent::from_url(source.to_owned()),
                        Some(librqbit::AddTorrentOptions {
                            list_only: true,
                            ..Default::default()
                        }),
                    )
                    .await
                    .map_err(torrent_engine_error)?;
                match response {
                    librqbit::AddTorrentResponse::ListOnly(response) => {
                        parse_torrent_preview(&response.torrent_bytes)?
                    }
                    _ => {
                        return Err(DownloadError::new(
                            ErrorCode::TorrentEngine,
                            "torrent engine unexpectedly started a preview",
                            true,
                        ));
                    }
                }
            }
            _ => {
                return Err(DownloadError::new(
                    ErrorCode::TorrentInvalid,
                    "unsupported torrent preview source",
                    false,
                ));
            }
        };
        validate_metainfo_tracker_networks(&resolved.metainfo).await?;
        Ok(resolved)
    }
}

fn torrent_engine_error(error: impl std::fmt::Display) -> DownloadError {
    DownloadError::new(ErrorCode::TorrentEngine, error.to_string(), true)
}

pub async fn run_torrent_task(
    engine: &TorrentEngine,
    db: &Db,
    task: &Task,
    worker_id: &str,
    context: &TorrentRunContext<'_>,
) -> Result<TorrentTaskOutcome, DownloadError> {
    let target = TorrentStorageTarget::resolve(task, context.data_root, context.require_mount)?;
    let mut published = task.content_completed_at.is_some();
    if !published
        && task.phase.as_deref() == Some("publishing")
        && target.recover_published_path()?.is_some()
    {
        db.publish_torrent(task, worker_id).await?;
        published = true;
    }
    if !published {
        let remaining_bytes = task
            .total_bytes
            .unwrap_or_default()
            .saturating_sub(task.received_bytes);
        db.reserve_space(
            task,
            remaining_bytes,
            target.available_bytes()?,
            context.minimum_free_bytes,
        )
        .await?;
    }
    let mut output_folder = if published {
        target.final_path()
    } else {
        target.prepare_partial()?
    };
    let metainfo = task.torrent_metainfo.as_deref().ok_or_else(|| {
        DownloadError::new(
            ErrorCode::TorrentInvalid,
            "torrent task has no metadata",
            false,
        )
    })?;
    let mut handle = engine
        .add_torrent_bytes(
            metainfo,
            &task.selected_file_indices,
            &output_folder,
            Vec::new(),
        )
        .await?;
    let mut uploaded_before_session = task.uploaded_bytes;
    let mut seed_started = task.seed_started_at.as_deref().and_then(parse_timestamp);
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));

    let outcome = async {
        loop {
            tokio::select! {
                _ = context.shutdown.cancelled() => {
                    let _ = engine.remove(&handle).await;
                    return Ok(TorrentTaskOutcome::Shutdown);
                }
                _ = interval.tick() => {}
            }

            let current = db.get_task(&task.id).await?.ok_or_else(|| {
                DownloadError::new(ErrorCode::Database, "torrent task disappeared", false)
            })?;
            if let Some(control) = current.control_requested.as_deref() {
                let _ = engine.remove(&handle).await;
                match control {
                    "pause" => db.finish_control(task, false).await?,
                    "cancel" => {
                        if !published {
                            target.remove_partial()?;
                        }
                        db.finish_control(task, true).await?;
                    }
                    "stop_seeding" if published => db.complete_torrent(task, worker_id).await?,
                    _ => {
                        return Err(DownloadError::new(
                            ErrorCode::Internal,
                            "invalid torrent control request",
                            false,
                        ));
                    }
                }
                return Ok(if control == "stop_seeding" {
                    TorrentTaskOutcome::Complete
                } else {
                    TorrentTaskOutcome::Interrupted
                });
            }

            let stats = handle.stats();
            if let Some(error) = stats.error.as_deref() {
                return Err(DownloadError::new(ErrorCode::TorrentEngine, error, true));
            }
            let uploaded_bytes = uploaded_before_session.saturating_add(stats.uploaded_bytes);
            let (download_speed, upload_speed, peer_count) =
                stats.live.as_ref().map_or((0, 0, 0), |live| {
                    (
                        live.download_speed.as_bytes(),
                        live.upload_speed.as_bytes(),
                        live.snapshot.peer_stats.live,
                    )
                });
            let seeding = published && stats.finished;
            let file_progress = stats.file_progress.iter().copied().enumerate().collect();
            if !db
                .torrent_progress(
                    task,
                    worker_id,
                    TORRENT_LEASE,
                    &TorrentProgress {
                        received_bytes: stats.progress_bytes,
                        total_bytes: stats.total_bytes,
                        speed_bytes_per_second: download_speed,
                        uploaded_bytes,
                        upload_speed_bytes_per_second: upload_speed,
                        peer_count,
                        file_progress,
                        seeding,
                    },
                )
                .await?
            {
                continue;
            }

            if stats.finished && !published {
                uploaded_before_session = uploaded_bytes;
                engine.remove(&handle).await?;
                db.begin_torrent_publish(task, worker_id).await?;
                target.publish()?;
                db.publish_torrent(task, worker_id).await?;
                published = true;
                seed_started = Some(time::OffsetDateTime::now_utc());
                output_folder = target.final_path();
                handle = engine
                    .add_torrent_bytes(
                        metainfo,
                        &task.selected_file_indices,
                        &output_folder,
                        Vec::new(),
                    )
                    .await?;
                continue;
            }

            if seeding {
                let elapsed = seed_started.map_or(0, |started| {
                    (time::OffsetDateTime::now_utc() - started)
                        .whole_seconds()
                        .max(0) as u64
                });
                let total = task.total_bytes.unwrap_or(stats.total_bytes);
                if seeding_limit_reached(
                    uploaded_bytes,
                    total,
                    task.seed_ratio_limit,
                    elapsed,
                    task.seed_time_limit_seconds,
                ) {
                    engine.remove(&handle).await?;
                    db.complete_torrent(task, worker_id).await?;
                    return Ok(TorrentTaskOutcome::Complete);
                }
            }
        }
    }
    .await;
    if outcome.is_err() {
        let _ = engine.remove(&handle).await;
    }
    outcome
}

fn parse_timestamp(value: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
}

pub fn parse_torrent_preview(bytes: &[u8]) -> Result<ResolvedTorrentPreview, DownloadError> {
    let metainfo = librqbit::torrent_from_bytes(bytes).map_err(|error| {
        DownloadError::new(
            ErrorCode::TorrentInvalid,
            format!("invalid torrent metadata: {error}"),
            false,
        )
    })?;
    for tracker in metainfo.iter_announce() {
        validate_tracker(std::str::from_utf8(tracker.as_ref()).map_err(|_| {
            DownloadError::new(
                ErrorCode::TorrentInvalid,
                "torrent tracker is not UTF-8",
                false,
            )
        })?)?;
    }
    let info_hash = metainfo.info_hash.as_string();
    let info = metainfo.info.data.validate().map_err(|error| {
        DownloadError::new(
            ErrorCode::TorrentInvalid,
            format!("invalid torrent file paths: {error}"),
            false,
        )
    })?;
    if info.info().private {
        return Err(DownloadError::new(
            ErrorCode::TorrentPrivate,
            "private torrents are not supported",
            false,
        ));
    }
    let name = info
        .name()
        .map(|value| value.into_owned())
        .unwrap_or_else(|| "torrent".to_owned());
    let mut total_bytes = 0_u64;
    let mut files = Vec::new();
    for (file_index, file) in info.iter_file_details().enumerate() {
        if file_index >= MAX_TORRENT_FILES {
            return Err(DownloadError::new(
                ErrorCode::TorrentInvalid,
                "torrent has too many files (maximum 10000)",
                false,
            ));
        }
        if file.attrs().symlink || file.symlink_path.is_some() {
            return Err(DownloadError::new(
                ErrorCode::TorrentInvalid,
                "torrent contains a symbolic link entry",
                false,
            ));
        }
        total_bytes = total_bytes.checked_add(file.len).ok_or_else(|| {
            DownloadError::new(
                ErrorCode::SizeLimit,
                "torrent size exceeds supported range",
                false,
            )
        })?;
        files.push(TorrentFile {
            file_index,
            path: file.filename.to_pathbuf().to_string_lossy().into_owned(),
            size_bytes: file.len,
        });
    }
    Ok(ResolvedTorrentPreview {
        info_hash,
        name,
        metainfo: bytes.to_vec(),
        total_bytes,
        files,
    })
}

fn validate_tracker(raw: &str) -> Result<(), DownloadError> {
    let tracker = url::Url::parse(raw).map_err(|_| unsafe_tracker())?;
    if !matches!(tracker.scheme(), "http" | "https" | "udp")
        || !tracker.username().is_empty()
        || tracker.password().is_some()
        || tracker.host_str().is_none()
    {
        return Err(unsafe_tracker());
    }
    if tracker
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(is_non_public_ip)
    {
        return Err(unsafe_tracker());
    }
    Ok(())
}

async fn validate_metainfo_tracker_networks(bytes: &[u8]) -> Result<(), DownloadError> {
    let metainfo = librqbit::torrent_from_bytes(bytes)
        .map_err(|error| DownloadError::new(ErrorCode::TorrentInvalid, error.to_string(), false))?;
    for tracker in metainfo.iter_announce() {
        let tracker = std::str::from_utf8(tracker.as_ref()).map_err(|_| unsafe_tracker())?;
        validate_tracker_network(tracker).await?;
    }
    Ok(())
}

async fn validate_tracker_network(raw: &str) -> Result<(), DownloadError> {
    validate_tracker(raw)?;
    let tracker = url::Url::parse(raw).map_err(|_| unsafe_tracker())?;
    let host = tracker.host_str().ok_or_else(unsafe_tracker)?;
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = tracker
        .port_or_known_default()
        .or_else(|| (tracker.scheme() == "udp").then_some(80))
        .ok_or_else(unsafe_tracker)?;
    let addresses = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| unsafe_tracker())?
    .map_err(|_| unsafe_tracker())?
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_non_public_ip(address.ip()))
    {
        return Err(unsafe_tracker());
    }
    Ok(())
}

fn unsafe_tracker() -> DownloadError {
    DownloadError::new(
        ErrorCode::TorrentUnsafe,
        "torrent must use a public tracker",
        false,
    )
}

fn is_non_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
                || address.is_documentation()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (address.segments()[0] & 0xfe00) == 0xfc00
                || (address.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

pub fn seeding_limit_reached(
    uploaded_bytes: u64,
    total_bytes: u64,
    ratio_limit: f64,
    elapsed_seconds: u64,
    time_limit_seconds: u64,
) -> bool {
    let ratio_reached = ratio_limit <= 0.0
        || total_bytes > 0 && uploaded_bytes as f64 / total_bytes as f64 >= ratio_limit;
    ratio_reached || elapsed_seconds >= time_limit_seconds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_public_multifile_torrents_for_selection() {
        let parsed = parse_torrent_preview(&torrent_fixture(false, None, false)).unwrap();
        assert_eq!(parsed.name, "release");
        assert_eq!(parsed.total_bytes, 12);
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(parsed.files[0].file_index, 0);
        assert_eq!(parsed.files[0].path, "a.txt");
        assert_eq!(parsed.files[1].path, "b.txt");
        assert_eq!(parsed.info_hash.len(), 40);
    }

    #[test]
    fn rejects_private_symlink_and_local_tracker_torrents() {
        assert!(
            parse_torrent_preview(&torrent_fixture(true, None, false))
                .unwrap_err()
                .to_string()
                .contains("private")
        );
        assert!(
            parse_torrent_preview(&torrent_fixture(false, None, true))
                .unwrap_err()
                .to_string()
                .contains("symbolic link")
        );
        assert!(
            parse_torrent_preview(&torrent_fixture(
                false,
                Some("http://127.0.0.1:8080/announce"),
                false,
            ))
            .unwrap_err()
            .to_string()
            .contains("public tracker")
        );
    }

    #[test]
    fn rejects_torrents_with_more_than_ten_thousand_files() {
        let error = parse_torrent_preview(&torrent_with_file_count(10_001)).unwrap_err();

        assert_eq!(error.code, ErrorCode::TorrentInvalid);
        assert!(error.to_string().contains("too many files"));
    }

    #[test]
    fn stops_seeding_at_the_first_ratio_or_time_limit() {
        assert!(!seeding_limit_reached(9, 10, 1.0, 7_199, 7_200));
        assert!(seeding_limit_reached(10, 10, 1.0, 1, 7_200));
        assert!(seeding_limit_reached(0, 10, 1.0, 7_200, 7_200));
    }

    #[tokio::test]
    async fn downloads_from_an_isolated_local_peer() {
        let seed_root = tempfile::tempdir().unwrap();
        let download_root = tempfile::tempdir().unwrap();
        std::fs::write(seed_root.path().join("hello.txt"), b"hello").unwrap();
        let metainfo = single_file_torrent_fixture();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let peer_address = listener.local_addr().unwrap();
        drop(listener);

        let seed = TorrentEngine::new_isolated(seed_root.path(), Some(peer_address))
            .await
            .unwrap();
        let seed_handle = seed
            .add_torrent_bytes(&metainfo, &[0], seed_root.path(), Vec::new())
            .await
            .unwrap();
        seed_handle.wait_until_initialized().await.unwrap();
        assert!(seed_handle.stats().finished);

        let download = TorrentEngine::new_isolated(download_root.path(), None)
            .await
            .unwrap();
        let handle = download
            .add_torrent_bytes(&metainfo, &[0], download_root.path(), vec![peer_address])
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            handle.wait_until_completed(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            std::fs::read(download_root.path().join("hello.txt")).unwrap(),
            b"hello"
        );
    }

    fn torrent_fixture(private: bool, tracker: Option<&str>, symlink: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"d");
        if let Some(tracker) = tracker {
            bytes.extend_from_slice(format!("8:announce{}:{}", tracker.len(), tracker).as_bytes());
        }
        bytes.extend_from_slice(b"4:infod5:filesl");
        bytes.extend_from_slice(b"d");
        if symlink {
            bytes.extend_from_slice(b"4:attr1:l");
        }
        bytes.extend_from_slice(b"6:lengthi5e4:pathl5:a.txtee");
        bytes.extend_from_slice(b"d6:lengthi7e4:pathl5:b.txtee");
        bytes.extend_from_slice(
            b"e4:name7:release12:piece lengthi16384e6:pieces20:01234567890123456789",
        );
        if private {
            bytes.extend_from_slice(b"7:privatei1e");
        }
        bytes.extend_from_slice(b"ee");
        bytes
    }

    fn single_file_torrent_fixture() -> Vec<u8> {
        let mut bytes =
            b"d4:infod6:lengthi5e4:name9:hello.txt12:piece lengthi16384e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[
            0xaa, 0xf4, 0xc6, 0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b, 0x48,
            0x2c, 0xd9, 0xae, 0xa9, 0x43, 0x4d,
        ]);
        bytes.extend_from_slice(b"ee");
        bytes
    }

    fn torrent_with_file_count(file_count: usize) -> Vec<u8> {
        let mut bytes = b"d4:infod5:filesl".to_vec();
        for index in 0..file_count {
            let name = format!("{index:05}.txt");
            bytes.extend_from_slice(
                format!("d6:lengthi1e4:pathl{}:{}ee", name.len(), name).as_bytes(),
            );
        }
        bytes.extend_from_slice(
            b"e4:name7:release12:piece lengthi16384e6:pieces20:01234567890123456789ee",
        );
        bytes
    }
}
