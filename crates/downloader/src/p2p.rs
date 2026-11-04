use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use futures_util::StreamExt;

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
        let parsed = parse_torrent_preview(metainfo)?;
        let metainfo = filter_metainfo_tracker_networks(&parsed.metainfo).await?;
        let response = self
            .session
            .add_torrent(
                librqbit::AddTorrent::from_bytes(metainfo),
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
        let mut resolved = match preview.source_kind.as_str() {
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
                let source = filter_magnet_trackers(source).await?;
                let response = self
                    .session
                    .add_torrent(
                        librqbit::AddTorrent::from_url(source),
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
        resolved.metainfo = filter_metainfo_tracker_networks(&resolved.metainfo).await?;
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
    let info_hash = metainfo.info_hash.as_string();
    let info = metainfo.info.data.clone().validate().map_err(|error| {
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
    let trackers = usable_trackers(metainfo.iter_announce().map(|tracker| {
        let raw = tracker_text(tracker.as_ref())?;
        validate_tracker(raw)?;
        Ok(raw)
    }))?;
    Ok(ResolvedTorrentPreview {
        info_hash,
        name,
        metainfo: encode_torrent_trackers(&metainfo, &trackers),
        total_bytes,
        files,
    })
}

fn tracker_text(bytes: &[u8]) -> Result<&str, DownloadError> {
    std::str::from_utf8(bytes).map_err(|_| blocked_tracker("tracker URL is not UTF-8"))
}

fn usable_trackers<T>(
    results: impl IntoIterator<Item = Result<T, DownloadError>>,
) -> Result<Vec<T>, DownloadError> {
    let mut trackers = Vec::new();
    let mut errors = Vec::new();
    for result in results {
        match result {
            Ok(tracker) => trackers.push(tracker),
            Err(error) => {
                tracing::warn!(message = %error.message, "ignoring unusable torrent tracker");
                errors.push(error);
            }
        }
    }
    if trackers.is_empty() && !errors.is_empty() {
        return Err(DownloadError::new(
            errors[0].code,
            format!(
                "no usable public tracker: {}",
                errors
                    .iter()
                    .take(5)
                    .map(|error| error.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            errors.iter().all(|error| error.retryable),
        ));
    }
    Ok(trackers)
}

fn validate_tracker(raw: &str) -> Result<url::Url, DownloadError> {
    let tracker = url::Url::parse(raw).map_err(|_| blocked_tracker("invalid tracker URL"))?;
    let host = tracker
        .host_str()
        .unwrap_or("<missing host>")
        .trim_matches(['[', ']']);
    if !matches!(tracker.scheme(), "http" | "https" | "udp") {
        return Err(blocked_tracker(format!(
            "tracker {host}: unsupported URL scheme"
        )));
    }
    if !tracker.username().is_empty() || tracker.password().is_some() {
        return Err(blocked_tracker(format!(
            "tracker {host}: URL credentials are not supported"
        )));
    }
    if tracker.host_str().is_none() {
        return Err(blocked_tracker("tracker URL has no host"));
    }
    if host.parse::<IpAddr>().is_ok_and(is_non_public_ip) {
        return Err(blocked_tracker(format!(
            "tracker {host}: non-public address is blocked"
        )));
    }
    Ok(tracker)
}

async fn filter_tracker_networks(trackers: &[&str]) -> Result<Vec<String>, DownloadError> {
    let trackers = trackers
        .iter()
        .map(|tracker| (*tracker).to_owned())
        .collect::<Vec<_>>();
    let results = futures_util::stream::iter(trackers)
        .map(|tracker| async move {
            validate_tracker_network(&tracker).await?;
            Ok(tracker)
        })
        .buffered(8)
        .collect::<Vec<_>>()
        .await;
    usable_trackers(results)
}

async fn filter_metainfo_tracker_networks(bytes: &[u8]) -> Result<Vec<u8>, DownloadError> {
    let metainfo = librqbit::torrent_from_bytes(bytes)
        .map_err(|error| DownloadError::new(ErrorCode::TorrentInvalid, error.to_string(), false))?;
    let trackers = usable_trackers(
        metainfo
            .iter_announce()
            .map(|tracker| tracker_text(tracker.as_ref())),
    )?;
    let trackers = filter_tracker_networks(&trackers).await?;
    Ok(encode_torrent_trackers(&metainfo, &trackers))
}

async fn filter_magnet_trackers(source: &str) -> Result<String, DownloadError> {
    let magnet = librqbit::Magnet::parse(source)
        .map_err(|error| DownloadError::new(ErrorCode::TorrentInvalid, error.to_string(), false))?;
    let trackers = magnet
        .trackers
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let trackers = filter_tracker_networks(&trackers).await?;
    let mut source = url::Url::parse(source)
        .map_err(|_| DownloadError::new(ErrorCode::TorrentInvalid, "invalid magnet URL", false))?;
    let pairs = source
        .query_pairs()
        .filter(|(key, _)| key != "tr")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    source.set_query(None);
    {
        let mut query = source.query_pairs_mut();
        query.extend_pairs(pairs);
        for tracker in trackers {
            query.append_pair("tr", &tracker);
        }
    }
    Ok(source.into())
}

async fn validate_tracker_network(raw: &str) -> Result<(), DownloadError> {
    let tracker = validate_tracker(raw)?;
    let host = tracker
        .host_str()
        .expect("validated tracker host")
        .trim_matches(['[', ']']);
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = tracker
        .port_or_known_default()
        .or_else(|| (tracker.scheme() == "udp").then_some(80))
        .ok_or_else(|| blocked_tracker(format!("tracker {host}: missing port")))?;
    validate_tracker_dns(
        host,
        async {
            tokio::net::lookup_host((host, port))
                .await
                .map(|addresses| addresses.collect())
        },
        std::time::Duration::from_secs(5),
    )
    .await
}

async fn validate_tracker_dns(
    host: &str,
    lookup: impl std::future::Future<Output = std::io::Result<Vec<SocketAddr>>>,
    timeout: std::time::Duration,
) -> Result<(), DownloadError> {
    let addresses = tokio::time::timeout(timeout, lookup)
        .await
        .map_err(|_| {
            DownloadError::new(
                ErrorCode::Timeout,
                format!("tracker {host}: DNS lookup timed out"),
                true,
            )
        })?
        .map_err(|error| {
            DownloadError::new(
                ErrorCode::Dns,
                format!("tracker {host}: DNS lookup failed: {error}"),
                true,
            )
        })?;
    if addresses.is_empty() {
        return Err(DownloadError::new(
            ErrorCode::Dns,
            format!("tracker {host}: DNS returned no addresses"),
            true,
        ));
    }
    if let Some(address) = addresses
        .iter()
        .find(|address| is_non_public_ip(address.ip()))
    {
        return Err(blocked_tracker(format!(
            "tracker {host}: DNS resolved to non-public address {}",
            address.ip()
        )));
    }
    Ok(())
}

fn blocked_tracker(message: impl Into<String>) -> DownloadError {
    DownloadError::new(ErrorCode::TorrentUnsafe, message, false)
}

fn bencode_string(bytes: &[u8]) -> Vec<u8> {
    let mut encoded = format!("{}:", bytes.len()).into_bytes();
    encoded.extend_from_slice(bytes);
    encoded
}

fn encode_torrent_trackers(
    metainfo: &librqbit::TorrentMetaV1Borrowed<'_>,
    trackers: &[impl AsRef<str>],
) -> Vec<u8> {
    let mut fields: BTreeMap<&[u8], Vec<u8>> = BTreeMap::new();
    for (key, value) in [
        (b"comment".as_slice(), metainfo.comment.as_ref()),
        (b"created by".as_slice(), metainfo.created_by.as_ref()),
        (b"encoding".as_slice(), metainfo.encoding.as_ref()),
        (b"publisher".as_slice(), metainfo.publisher.as_ref()),
        (b"publisher-url".as_slice(), metainfo.publisher_url.as_ref()),
    ] {
        if let Some(value) = value {
            fields.insert(key, bencode_string(value.as_ref()));
        }
    }
    if let Some(date) = metainfo.creation_date {
        fields.insert(b"creation date", format!("i{date}e").into_bytes());
    }
    // Re-encoding the info dictionary can change the swarm identity or file paths.
    // Copy its exact bytes, including fields unknown to librqbit.
    fields.insert(b"info", metainfo.info.raw_bytes.as_ref().to_vec());
    if let Some(first) = trackers.first() {
        fields.insert(b"announce", bencode_string(first.as_ref().as_bytes()));
        let mut list = b"l".to_vec();
        for tracker in trackers {
            list.push(b'l');
            list.extend(bencode_string(tracker.as_ref().as_bytes()));
            list.push(b'e');
        }
        list.push(b'e');
        fields.insert(b"announce-list", list);
    }
    let mut bytes = b"d".to_vec();
    for (key, value) in fields {
        bytes.extend(bencode_string(key));
        bytes.extend(value);
    }
    bytes.push(b'e');
    bytes
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
            address
                .to_ipv4_mapped()
                .is_some_and(|address| is_non_public_ip(IpAddr::V4(address)))
                || address.is_loopback()
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
    fn removes_blocked_trackers_without_changing_torrent_contents() {
        let bytes = torrent_with_trackers(&[
            "http://127.0.0.1:8080/announce",
            "udp://8.8.8.8:6969/announce",
            "file:///etc/passwd",
        ]);
        let original = librqbit::torrent_from_bytes(&bytes).unwrap();
        let parsed = parse_torrent_preview(&bytes).unwrap();
        let filtered = librqbit::torrent_from_bytes(&parsed.metainfo).unwrap();

        assert_eq!(parsed.info_hash, original.info_hash.as_string());
        assert_eq!(filtered.info.raw_bytes, original.info.raw_bytes);
        assert_eq!(parsed.total_bytes, 12);
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(
            filtered
                .iter_announce()
                .map(|v| v.as_ref())
                .collect::<Vec<_>>(),
            vec![b"udp://8.8.8.8:6969/announce".as_slice()]
        );
        assert_eq!(
            filtered.announce.unwrap().as_ref(),
            b"udp://8.8.8.8:6969/announce"
        );
    }

    #[test]
    fn identifies_the_host_and_reason_when_no_public_tracker_remains() {
        let error = parse_torrent_preview(&torrent_with_trackers(&[
            "http://127.0.0.1:8080/announce",
            "http://10.0.0.1/announce?passkey=secret",
        ]))
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::TorrentUnsafe);
        assert!(error.message.contains("127.0.0.1"));
        assert!(error.message.contains("non-public"));
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn preserves_unknown_info_fields_and_text_encoding() {
        let base = torrent_with_trackers(&["udp://8.8.8.8:6969/announce"]);
        let info_offset = base.windows(7).position(|v| v == b"4:infod").unwrap();
        let mut bytes = base[..info_offset].to_vec();
        bytes.extend_from_slice(b"8:encoding5:UTF-84:infod13:x-content-tag4:keep");
        bytes.extend_from_slice(&base[info_offset + 7..]);
        let original = librqbit::torrent_from_bytes(&bytes).unwrap();
        let parsed = parse_torrent_preview(&bytes).unwrap();
        let filtered = librqbit::torrent_from_bytes(&parsed.metainfo).unwrap();

        assert_eq!(filtered.info.raw_bytes, original.info.raw_bytes);
        assert_eq!(filtered.info_hash, original.info_hash);
        assert_eq!(filtered.encoding.unwrap().as_ref(), b"UTF-8");
    }

    #[tokio::test]
    async fn distinguishes_dns_failure_timeout_and_non_public_results() {
        let timeout = std::time::Duration::from_millis(1);
        let error = validate_tracker_dns(
            "missing.invalid",
            async { Err(std::io::Error::from(std::io::ErrorKind::NotFound)) },
            timeout,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Dns);
        assert!(error.retryable);
        assert!(error.message.contains("missing.invalid"));
        assert!(error.message.contains("DNS lookup failed"));

        let error = validate_tracker_dns("slow.example", std::future::pending(), timeout)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.message.contains("slow.example"));
        assert!(error.message.contains("timed out"));

        let error = validate_tracker_dns(
            "mixed.example",
            async {
                Ok(vec![
                    "8.8.8.8:80".parse().unwrap(),
                    "10.255.255.254:80".parse().unwrap(),
                ])
            },
            timeout,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::TorrentUnsafe);
        assert!(!error.retryable);
        assert!(error.message.contains("mixed.example"));
        assert!(error.message.contains("10.255.255.254"));

        let error = validate_tracker_dns("empty.example", async { Ok(Vec::new()) }, timeout)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Dns);
        assert!(error.message.contains("no addresses"));
    }

    #[tokio::test]
    async fn filters_magnet_trackers_without_injecting_query_parameters() {
        let source = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=release&tr=http%3A%2F%2F127.0.0.1%2Fannounce&tr=udp%3A%2F%2F8.8.8.8%3A6969%2Fannounce%3Fa%3D1%26tr%3Dhttp%3A%2F%2F10.0.0.1%2Fannounce";
        let filtered = filter_magnet_trackers(source).await.unwrap();
        let magnet = librqbit::Magnet::parse(&filtered).unwrap();
        assert_eq!(
            magnet.as_id20().unwrap().as_string(),
            "0123456789012345678901234567890123456789"
        );
        assert_eq!(magnet.name.as_deref(), Some("release"));
        assert_eq!(
            magnet.trackers,
            ["udp://8.8.8.8:6969/announce?a=1&tr=http://10.0.0.1/announce"]
        );

        let error = filter_magnet_trackers("magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=http://127.0.0.1/announce").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::TorrentUnsafe);
        assert!(error.message.contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn filters_trackers_again_before_starting_the_download_engine() {
        let root = tempfile::tempdir().unwrap();
        let engine = TorrentEngine::new_isolated(root.path(), None)
            .await
            .unwrap();
        let bytes = torrent_with_trackers(&[
            "https://missing-tracker.invalid/announce",
            "http://10.0.0.1/announce",
            "udp://8.8.8.8:6969/announce",
        ]);
        let handle = engine
            .add_torrent_bytes(&bytes, &[0, 1], root.path(), Vec::new())
            .await
            .unwrap();
        let bytes = handle
            .with_metadata(|metadata| metadata.torrent_bytes.clone())
            .unwrap();
        let parsed = librqbit::torrent_from_bytes(&bytes).unwrap();
        assert_eq!(
            parsed
                .iter_announce()
                .map(|v| v.as_ref())
                .collect::<Vec<_>>(),
            vec![b"udp://8.8.8.8:6969/announce".as_slice()]
        );
        engine.remove(&handle).await.unwrap();
    }

    #[tokio::test]
    async fn accepts_public_ipv6_trackers_and_rejects_local_ipv6() {
        validate_tracker_network("udp://[2606:4700:4700::1111]:6969/announce")
            .await
            .unwrap();
        assert!(validate_tracker("http://[::1]:8080/announce").is_err());
        assert!(validate_tracker("http://[::ffff:127.0.0.1]:8080/announce").is_err());
    }

    #[tokio::test]
    async fn resolves_preview_when_one_tracker_has_no_dns_record() {
        let root = tempfile::tempdir().unwrap();
        let engine = TorrentEngine::new_isolated(root.path(), None)
            .await
            .unwrap();
        let preview = TorrentPreview {
            id: "mixed-trackers".to_owned(),
            source_kind: "torrent".to_owned(),
            source_uri: None,
            metainfo: Some(torrent_with_trackers(&[
                "https://missing-tracker.invalid/announce",
                "udp://8.8.8.8:6969/announce",
            ])),
        };
        let parsed = engine.resolve_preview(&preview).await.unwrap();
        let filtered = librqbit::torrent_from_bytes(&parsed.metainfo).unwrap();
        assert_eq!(
            filtered
                .iter_announce()
                .map(|v| v.as_ref())
                .collect::<Vec<_>>(),
            vec![b"udp://8.8.8.8:6969/announce".as_slice()]
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

    fn torrent_with_trackers(trackers: &[&str]) -> Vec<u8> {
        let mut bytes = b"d8:announce".to_vec();
        let first = trackers.first().unwrap();
        bytes.extend_from_slice(format!("{}:{}13:announce-listl", first.len(), first).as_bytes());
        for tracker in trackers {
            bytes.extend_from_slice(format!("l{}:{}e", tracker.len(), tracker).as_bytes());
        }
        bytes.push(b'e');
        bytes.extend_from_slice(&torrent_fixture(false, None, false)[1..]);
        bytes
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
