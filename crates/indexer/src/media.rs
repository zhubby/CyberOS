use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::db::Db;
use crate::error::{ErrorCode, IndexerError};
use crate::storage::{EntryKind, StoragePoolStorage, probe_mount_identity};

const MAX_NFO_BYTES: u64 = 1024 * 1024;
const TMDB_API_BASE: &str = "https://api.themoviedb.org";
const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts"];
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[derive(Debug, Clone)]
pub struct MediaScanTask {
    pub id: String,
    pub generation: String,
    pub source_id: String,
    pub kind: String,
    pub storage_pool_id: String,
    pub source_path: String,
    pub storage_pool_path: String,
    pub mount_policy: String,
    pub expected_source: Option<String>,
    pub expected_uuid: Option<String>,
    pub expected_fstype: Option<String>,
    pub settings_json: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaTitleInput {
    pub source_path: String,
    pub tmdb_id: Option<i64>,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub year: Option<i64>,
    pub release_date: Option<String>,
    pub runtime_minutes: Option<i64>,
    pub original_language: Option<String>,
    pub genres: Vec<String>,
    pub metadata_source: String,
    pub match_status: String,
    pub match_confidence: Option<f64>,
    pub poster_key: Option<String>,
    pub backdrop_key: Option<String>,
    pub rating: Option<f64>,
    pub credits: Vec<MediaCreditInput>,
    pub collection: Option<(i64, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MediaCreditInput {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaSeasonInput {
    pub number: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub poster_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaEpisodeInput {
    pub number: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub runtime_minutes: Option<i64>,
    pub still_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaFileInput {
    pub relative_path: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub mtime_ms: i64,
    pub duration_seconds: Option<f64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaArtworkInput {
    pub kind: String,
    pub source: String,
    pub source_url: Option<String>,
    pub cache_key: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub language: Option<String>,
    pub is_primary: bool,
    pub for_season: bool,
    pub for_episode: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaCatalogEntry {
    pub title: MediaTitleInput,
    pub season: Option<MediaSeasonInput>,
    pub episode: Option<MediaEpisodeInput>,
    pub file: MediaFileInput,
    pub artwork: Vec<MediaArtworkInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MediaSettings {
    tmdb_read_access_token: Option<String>,
    language: String,
    region: Option<String>,
}

impl Default for MediaSettings {
    fn default() -> Self {
        Self {
            tmdb_read_access_token: None,
            language: "zh-CN".to_owned(),
            region: Some("CN".to_owned()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
struct NfoMetadata {
    title: Option<String>,
    original_title: Option<String>,
    overview: Option<String>,
    year: Option<i64>,
    release_date: Option<String>,
    runtime_minutes: Option<i64>,
    original_language: Option<String>,
    genres: Vec<String>,
    tmdb_id: Option<i64>,
    season: Option<i64>,
    episode: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct TmdbSearchResponse {
    #[serde(default)]
    results: Vec<TmdbSearchResult>,
}

#[derive(Debug, Clone, Deserialize)]
struct TmdbSearchResult {
    id: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    original_title: Option<String>,
    #[serde(default)]
    original_name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    first_air_date: Option<String>,
    #[serde(default)]
    original_language: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default)]
    backdrop_path: Option<String>,
}

#[derive(Clone)]
struct TmdbClient {
    client: reqwest::Client,
    base_url: Url,
    token: String,
    language: String,
    region: Option<String>,
}

impl TmdbClient {
    async fn details(&self, kind: &str, id: i64) -> Result<serde_json::Value, IndexerError> {
        let mut url = self
            .base_url
            .join(&format!(
                "3/{}/{id}",
                if kind == "movie" { "movie" } else { "tv" }
            ))
            .map_err(|_| tmdb_error("Invalid TMDB details URL"))?;
        url.query_pairs_mut()
            .append_pair("language", &self.language)
            .append_pair("append_to_response", "credits");
        let mut response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| tmdb_error("TMDB details unavailable"))?;
        if !response.status().is_success() {
            return Err(tmdb_error("TMDB details unavailable"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| tmdb_error("TMDB details unavailable"))?
        {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(tmdb_error("TMDB details too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| tmdb_error("Invalid TMDB details"))
    }
    fn new(settings: &MediaSettings) -> Result<Option<Self>, IndexerError> {
        let Some(token) = settings
            .tmdb_read_access_token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
        else {
            return Ok(None);
        };
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| tmdb_error("Unable to initialize TMDB client"))?;
        Ok(Some(Self {
            client,
            base_url: Url::parse(TMDB_API_BASE).expect("valid TMDB API URL"),
            token: token.to_owned(),
            language: settings.language.clone(),
            region: settings.region.clone(),
        }))
    }

    async fn search(
        &self,
        kind: &str,
        title: &str,
        year: Option<i64>,
    ) -> Result<Vec<TmdbSearchResult>, IndexerError> {
        let route = if kind == "movie" {
            "3/search/movie"
        } else {
            "3/search/tv"
        };
        let mut url = self
            .base_url
            .join(route)
            .map_err(|_| tmdb_error("Unable to construct TMDB request"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("query", title);
            query.append_pair("language", &self.language);
            if kind == "movie"
                && let Some(region) = &self.region
            {
                query.append_pair("region", region);
            }
            if let Some(year) = year {
                query.append_pair(
                    if kind == "movie" {
                        "year"
                    } else {
                        "first_air_date_year"
                    },
                    &year.to_string(),
                );
            }
        }
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| tmdb_error("TMDB lookup failed"))?;
        if !response.status().is_success() {
            return Err(tmdb_error(format!(
                "TMDB lookup returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| tmdb_error("TMDB response could not be read"))?;
        serde_json::from_slice::<TmdbSearchResponse>(&bytes)
            .map(|response| response.results)
            .map_err(|_| tmdb_error("TMDB response was invalid"))
    }
}

pub async fn run_media_scan(
    db: &Db,
    task: &MediaScanTask,
    worker_id: &str,
    shutdown: &CancellationToken,
) -> Result<(), IndexerError> {
    let settings = task
        .settings_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<MediaSettings>(json).ok())
        .unwrap_or_default();
    let tmdb = TmdbClient::new(&settings)?;
    let storage = StoragePoolStorage::open(Path::new(&task.storage_pool_path))?;
    let source_path = PathBuf::from(&task.source_path);
    let initial_mount = probe_mount_identity(
        storage.path(),
        &task.mount_policy,
        task.expected_source.as_deref(),
        task.expected_uuid.as_deref(),
        task.expected_fstype.as_deref(),
    )
    .await?;
    storage.open_directory(&source_path)?;
    let files = discover_video_files(&storage, &source_path, shutdown)?;
    let mut entries = Vec::with_capacity(files.len());
    let mut title_cache = HashMap::<String, MediaTitleInput>::new();
    let overrides = db.media_match_overrides(&task.source_id).await?;
    let mut details_cache = HashMap::<i64, Option<serde_json::Value>>::new();
    let mut unmatched = 0_u64;
    for (index, relative_path) in files.iter().enumerate() {
        if shutdown.is_cancelled() {
            return Err(IndexerError::new(
                ErrorCode::Internal,
                "Indexer is stopping",
                true,
            ));
        }
        let mut entry = build_entry(
            &storage,
            task,
            relative_path,
            tmdb.as_ref(),
            &mut title_cache,
        )
        .await?;
        let overridden = overrides.get(&entry.title.source_path).copied().flatten();
        if let Some(id) = overridden {
            entry.title.tmdb_id = Some(id);
        }
        if let (Some(client), Some(id)) = (tmdb.as_ref(), entry.title.tmdb_id) {
            if let std::collections::hash_map::Entry::Vacant(slot) = details_cache.entry(id) {
                slot.insert(client.details(&task.kind, id).await.ok());
            }
            if let Some(Some(value)) = details_cache.get(&id) {
                apply_tmdb_details(&mut entry.title, value, overridden.is_some());
                if overridden.is_some() {
                    entry
                        .artwork
                        .retain(|art| art.source != "tmdb" || art.for_episode);
                    for (kind, key) in [
                        ("poster", entry.title.poster_key.as_ref()),
                        ("backdrop", entry.title.backdrop_key.as_ref()),
                    ] {
                        if let Some(key) = key
                            && !entry
                                .artwork
                                .iter()
                                .any(|art| art.kind == kind && !art.for_episode)
                        {
                            entry.artwork.push(tmdb_artwork(
                                kind,
                                key,
                                &settings_language(task),
                                false,
                            ));
                        }
                    }
                }
            }
        }
        unmatched += u64::from(entry.title.match_status != "matched");
        entries.push(entry);
        if index % 25 == 0 {
            let leased = db
                .update_media_scan_progress(
                    &task.id,
                    worker_id,
                    entries.len() as u64,
                    unmatched,
                    Some(&path_text(relative_path)),
                )
                .await?;
            if !leased {
                return Err(IndexerError::new(
                    ErrorCode::Database,
                    "Media scan lease was lost",
                    true,
                ));
            }
        }
    }
    storage.verify_unchanged()?;
    let final_mount = probe_mount_identity(
        storage.path(),
        &task.mount_policy,
        task.expected_source.as_deref(),
        task.expected_uuid.as_deref(),
        task.expected_fstype.as_deref(),
    )
    .await?;
    if final_mount != initial_mount {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            "mount identity changed during media scan",
            true,
        ));
    }
    db.publish_media_scan(task, worker_id, &entries).await
}

fn discover_video_files(
    storage: &StoragePoolStorage,
    source_path: &Path,
    shutdown: &CancellationToken,
) -> Result<Vec<PathBuf>, IndexerError> {
    let mut pending = VecDeque::from([source_path.to_path_buf()]);
    let mut files = Vec::new();
    while let Some(directory) = pending.pop_front() {
        if shutdown.is_cancelled() {
            return Err(IndexerError::new(
                ErrorCode::Internal,
                "Indexer is stopping",
                true,
            ));
        }
        for entry in storage.list_directory(&directory)? {
            let path = directory.join(&entry.name);
            match entry.kind {
                EntryKind::Directory => pending.push_back(path),
                EntryKind::File if is_video(&path) => files.push(path),
                EntryKind::File | EntryKind::Symlink | EntryKind::Other => {}
            }
        }
    }
    files.sort();
    Ok(files)
}

async fn build_entry(
    storage: &StoragePoolStorage,
    task: &MediaScanTask,
    relative_path: &Path,
    tmdb: Option<&TmdbClient>,
    title_cache: &mut HashMap<String, MediaTitleInput>,
) -> Result<MediaCatalogEntry, IndexerError> {
    let file_name = relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| IndexerError::invalid_path("Media file name must be valid UTF-8"))?;
    let stem = relative_path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| IndexerError::invalid_path("Media file name must have a stem"))?;
    let identity = storage.identity_for(relative_path)?;
    let extension = relative_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (title_source_path, title_directory, fallback_title, fallback_year, episode_numbers) =
        if task.kind == "series" {
            let episode = parse_episode_name(stem).ok_or_else(|| {
                IndexerError::new(
                    ErrorCode::CorruptDocument,
                    format!(
                        "Series file does not contain an SxxEyy episode number: {}",
                        path_text(relative_path)
                    ),
                    false,
                )
            })?;
            let source = PathBuf::from(&task.source_path);
            let show_directory = show_directory(relative_path, &source);
            let title_source_path = if show_directory == source {
                source.join(&episode.title)
            } else {
                show_directory.clone()
            };
            (
                path_text(&title_source_path),
                show_directory,
                episode.title,
                None,
                Some((episode.season, episode.episode)),
            )
        } else {
            let parsed = parse_movie_name(stem);
            let parent = relative_path.parent().unwrap_or(Path::new("."));
            let source = PathBuf::from(&task.source_path);
            let title_path = if parent == source {
                parent.join(stem)
            } else {
                parent.to_path_buf()
            };
            (
                path_text(&title_path),
                parent.to_path_buf(),
                parsed.0,
                parsed.1,
                None,
            )
        };

    let local_title_nfo = if task.kind == "series" {
        find_named_file(storage, &title_directory, &["tvshow.nfo"])?
    } else {
        let mut names = vec![format!("{stem}.nfo"), "movie.nfo".to_owned()];
        names.dedup();
        find_named_file(
            storage,
            relative_path.parent().unwrap_or(Path::new(".")),
            &names.iter().map(String::as_str).collect::<Vec<_>>(),
        )?
    };
    let title_nfo = local_title_nfo
        .as_deref()
        .map(|path| read_nfo(storage, path))
        .transpose()?;
    let cache_key = title_source_path.clone();
    let title = if let Some(cached) = title_cache.get(&cache_key) {
        cached.clone()
    } else {
        let resolved = resolve_title(
            task,
            &title_source_path,
            &fallback_title,
            fallback_year,
            title_nfo.as_ref(),
            tmdb,
        )
        .await?;
        title_cache.insert(cache_key, resolved.clone());
        resolved
    };

    let mut artwork = discover_local_artwork(
        storage,
        task,
        relative_path,
        &title_directory,
        episode_numbers.is_some(),
    )?;
    if artwork.iter().all(|item| item.kind != "poster")
        && let Some(key) = &title.poster_key
    {
        artwork.push(tmdb_artwork("poster", key, &settings_language(task), false));
    }
    if artwork.iter().all(|item| item.kind != "backdrop")
        && let Some(key) = &title.backdrop_key
    {
        artwork.push(tmdb_artwork(
            "backdrop",
            key,
            &settings_language(task),
            false,
        ));
    }

    let (season, episode) = if let Some((fallback_season, fallback_episode)) = episode_numbers {
        let episode_nfo_path = find_named_file(
            storage,
            relative_path.parent().unwrap_or(Path::new(".")),
            &[&format!("{stem}.nfo")],
        )?;
        let nfo = episode_nfo_path
            .as_deref()
            .map(|path| read_nfo(storage, path))
            .transpose()?;
        let season_number = nfo
            .as_ref()
            .and_then(|value| value.season)
            .unwrap_or(fallback_season);
        let episode_number = nfo
            .as_ref()
            .and_then(|value| value.episode)
            .unwrap_or(fallback_episode);
        let still_key = artwork
            .iter()
            .find(|item| item.kind == "still")
            .map(|item| item.cache_key.clone());
        (
            Some(MediaSeasonInput {
                number: season_number,
                name: Some(format!("Season {season_number}")),
                ..MediaSeasonInput::default()
            }),
            Some(MediaEpisodeInput {
                number: episode_number,
                name: nfo.as_ref().and_then(|value| value.title.clone()),
                overview: nfo.as_ref().and_then(|value| value.overview.clone()),
                air_date: nfo.as_ref().and_then(|value| value.release_date.clone()),
                runtime_minutes: nfo.as_ref().and_then(|value| value.runtime_minutes),
                still_key,
            }),
        )
    } else {
        (None, None)
    };

    Ok(MediaCatalogEntry {
        title,
        season,
        episode,
        file: MediaFileInput {
            relative_path: path_text(relative_path),
            name: file_name.to_owned(),
            mime_type: video_mime(&extension).to_owned(),
            size_bytes: identity.size,
            mtime_ms: (identity.mtime_ns / 1_000_000).max(0),
            container: Some(extension),
            ..MediaFileInput::default()
        },
        artwork,
    })
}

async fn resolve_title(
    task: &MediaScanTask,
    source_path: &str,
    fallback_title: &str,
    fallback_year: Option<i64>,
    nfo: Option<&NfoMetadata>,
    tmdb: Option<&TmdbClient>,
) -> Result<MediaTitleInput, IndexerError> {
    if let Some(nfo) = nfo {
        return Ok(MediaTitleInput {
            source_path: source_path.to_owned(),
            tmdb_id: nfo.tmdb_id,
            title: nfo
                .title
                .clone()
                .unwrap_or_else(|| fallback_title.to_owned()),
            original_title: nfo.original_title.clone(),
            overview: nfo.overview.clone(),
            year: nfo.year.or(fallback_year),
            release_date: nfo.release_date.clone(),
            runtime_minutes: nfo.runtime_minutes,
            original_language: nfo.original_language.clone(),
            genres: nfo.genres.clone(),
            metadata_source: "nfo".to_owned(),
            match_status: "matched".to_owned(),
            match_confidence: Some(1.0),
            poster_key: None,
            backdrop_key: None,
            ..MediaTitleInput::default()
        });
    }
    let Some(tmdb) = tmdb else {
        return Ok(filename_title(source_path, fallback_title, fallback_year));
    };
    let results = tmdb
        .search(&task.kind, fallback_title, fallback_year)
        .await?;
    match select_tmdb_match(&results, fallback_title, fallback_year) {
        TmdbMatch::Matched(result, confidence) => Ok(MediaTitleInput {
            source_path: source_path.to_owned(),
            tmdb_id: Some(result.id),
            title: result
                .title
                .clone()
                .or_else(|| result.name.clone())
                .unwrap_or_else(|| fallback_title.to_owned()),
            original_title: result
                .original_title
                .clone()
                .or_else(|| result.original_name.clone()),
            overview: result
                .overview
                .clone()
                .filter(|value| !value.trim().is_empty()),
            year: date_year(
                result
                    .release_date
                    .as_deref()
                    .or(result.first_air_date.as_deref()),
            )
            .or(fallback_year),
            release_date: result
                .release_date
                .clone()
                .or_else(|| result.first_air_date.clone())
                .filter(|value| !value.is_empty()),
            original_language: result.original_language.clone(),
            metadata_source: "tmdb".to_owned(),
            match_status: "matched".to_owned(),
            match_confidence: Some(confidence),
            poster_key: result
                .poster_path
                .clone()
                .map(|path| format!("tmdb/w500/{}", path.trim_start_matches('/'))),
            backdrop_key: result
                .backdrop_path
                .clone()
                .map(|path| format!("tmdb/w1280/{}", path.trim_start_matches('/'))),
            ..MediaTitleInput::default()
        }),
        TmdbMatch::Ambiguous => {
            let mut title = filename_title(source_path, fallback_title, fallback_year);
            title.match_status = "pending".to_owned();
            Ok(title)
        }
        TmdbMatch::None => Ok(filename_title(source_path, fallback_title, fallback_year)),
    }
}

fn apply_tmdb_details(
    title: &mut MediaTitleInput,
    value: &serde_json::Value,
    override_title: bool,
) {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    if override_title {
        if let Some(name) = text("title").or_else(|| text("name")) {
            title.title = name;
        }
        title.original_title = text("original_title").or_else(|| text("original_name"));
        title.overview = text("overview");
        title.release_date = text("release_date").or_else(|| text("first_air_date"));
        title.year = date_year(title.release_date.as_deref());
        title.metadata_source = "tmdb".into();
        title.match_status = "matched".into();
        title.poster_key =
            text("poster_path").map(|p| format!("tmdb/w500/{}", p.trim_start_matches('/')));
        title.backdrop_key =
            text("backdrop_path").map(|p| format!("tmdb/w1280/{}", p.trim_start_matches('/')));
    }
    title.runtime_minutes = title
        .runtime_minutes
        .or_else(|| value["runtime"].as_i64())
        .or_else(|| value["episode_run_time"][0].as_i64());
    if let Some(genres) = value["genres"].as_array() {
        title.genres = genres
            .iter()
            .filter_map(|g| g["name"].as_str().map(str::to_owned))
            .collect();
    }
    title.rating = value["vote_average"]
        .as_f64()
        .filter(|r| r.is_finite() && (0.0..=10.0).contains(r));
    if let Some(cast) = value["credits"]["cast"].as_array() {
        title.credits = cast
            .iter()
            .take(20)
            .filter_map(|c| {
                Some(MediaCreditInput {
                    name: c["name"].as_str()?.to_owned(),
                    role: c["character"].as_str().unwrap_or("Cast").to_owned(),
                })
            })
            .collect();
    }
    if let Some(crew) = value["credits"]["crew"].as_array() {
        title.credits.extend(
            crew.iter()
                .filter(|c| {
                    matches!(
                        c["job"].as_str(),
                        Some("Director" | "Writer" | "Screenplay")
                    )
                })
                .take(10)
                .filter_map(|c| {
                    Some(MediaCreditInput {
                        name: c["name"].as_str()?.to_owned(),
                        role: c["job"].as_str()?.to_owned(),
                    })
                }),
        );
    }
    title.collection = value["belongs_to_collection"]["id"].as_i64().zip(
        value["belongs_to_collection"]["name"]
            .as_str()
            .map(str::to_owned),
    );
}

fn filename_title(source_path: &str, title: &str, year: Option<i64>) -> MediaTitleInput {
    MediaTitleInput {
        source_path: source_path.to_owned(),
        title: title.to_owned(),
        year,
        metadata_source: "filename".to_owned(),
        match_status: "unmatched".to_owned(),
        ..MediaTitleInput::default()
    }
}

enum TmdbMatch<'a> {
    Matched(&'a TmdbSearchResult, f64),
    Ambiguous,
    None,
}

fn select_tmdb_match<'a>(
    results: &'a [TmdbSearchResult],
    title: &str,
    year: Option<i64>,
) -> TmdbMatch<'a> {
    let normalized = normalize_title(title);
    let exact = results
        .iter()
        .filter(|result| {
            let candidate = result
                .title
                .as_deref()
                .or(result.name.as_deref())
                .unwrap_or_default();
            normalize_title(candidate) == normalized
                && year.is_none_or(|expected| {
                    date_year(
                        result
                            .release_date
                            .as_deref()
                            .or(result.first_air_date.as_deref()),
                    ) == Some(expected)
                })
        })
        .collect::<Vec<_>>();
    match exact.as_slice() {
        [result] => TmdbMatch::Matched(result, 1.0),
        [_, ..] => TmdbMatch::Ambiguous,
        [] if results.len() == 1 && year.is_none() => TmdbMatch::Matched(&results[0], 0.75),
        [] if results.is_empty() => TmdbMatch::None,
        [] => TmdbMatch::Ambiguous,
    }
}

fn read_nfo(storage: &StoragePoolStorage, path: &Path) -> Result<NfoMetadata, IndexerError> {
    let file = storage.open_file(path)?;
    let mut limited = file.take(MAX_NFO_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(IndexerError::storage)?;
    if bytes.len() as u64 > MAX_NFO_BYTES {
        return Err(IndexerError::new(
            ErrorCode::SizeLimit,
            "NFO file exceeds 1 MiB",
            false,
        ));
    }
    parse_nfo(&bytes)
}

fn parse_nfo(bytes: &[u8]) -> Result<NfoMetadata, IndexerError> {
    let mut reader = Reader::from_reader(BufReader::new(bytes));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current = None::<String>;
    let mut current_uniqueid_is_tmdb = false;
    let mut metadata = NfoMetadata::default();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(start)) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).to_ascii_lowercase();
                current_uniqueid_is_tmdb = name == "uniqueid"
                    && start.attributes().flatten().any(|attribute| {
                        attribute.key.as_ref() == b"type"
                            && attribute.value.as_ref().eq_ignore_ascii_case(b"tmdb")
                    });
                current = Some(name);
            }
            Ok(Event::Text(text)) => {
                let decoded = text.decode().map_err(|_| invalid_nfo())?;
                let value = quick_xml::escape::unescape(&decoded).map_err(|_| invalid_nfo())?;
                apply_nfo_value(
                    &mut metadata,
                    current.as_deref(),
                    value.trim(),
                    current_uniqueid_is_tmdb,
                );
            }
            Ok(Event::End(_)) => {
                current = None;
                current_uniqueid_is_tmdb = false;
            }
            Ok(Event::Eof) => return Ok(metadata),
            Ok(_) => {}
            Err(_) => return Err(invalid_nfo()),
        }
        buffer.clear();
    }
}

fn apply_nfo_value(metadata: &mut NfoMetadata, tag: Option<&str>, value: &str, tmdb_id: bool) {
    if value.is_empty() {
        return;
    }
    match tag {
        Some("title") => metadata.title = Some(value.to_owned()),
        Some("originaltitle") => metadata.original_title = Some(value.to_owned()),
        Some("plot") | Some("outline") if metadata.overview.is_none() => {
            metadata.overview = Some(value.to_owned())
        }
        Some("year") => metadata.year = value.parse().ok(),
        Some("premiered") | Some("aired") if metadata.release_date.is_none() => {
            metadata.release_date = Some(value.to_owned())
        }
        Some("runtime") => {
            metadata.runtime_minutes = value
                .split_whitespace()
                .next()
                .and_then(|value| value.parse().ok())
        }
        Some("language") => metadata.original_language = Some(value.to_owned()),
        Some("genre") => metadata.genres.push(value.to_owned()),
        Some("season") => metadata.season = value.parse().ok(),
        Some("episode") => metadata.episode = value.parse().ok(),
        Some("tmdbid") => metadata.tmdb_id = value.parse().ok(),
        Some("uniqueid") if tmdb_id => metadata.tmdb_id = value.parse().ok(),
        _ => {}
    }
}

fn find_named_file(
    storage: &StoragePoolStorage,
    directory: &Path,
    names: &[&str],
) -> Result<Option<PathBuf>, IndexerError> {
    let candidates = names
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<Vec<_>>();
    Ok(storage
        .list_directory(directory)?
        .into_iter()
        .find_map(|entry| {
            (entry.kind == EntryKind::File && candidates.contains(&entry.name.to_ascii_lowercase()))
                .then(|| directory.join(entry.name))
        }))
}

fn discover_local_artwork(
    storage: &StoragePoolStorage,
    task: &MediaScanTask,
    media_path: &Path,
    title_path: &Path,
    episode: bool,
) -> Result<Vec<MediaArtworkInput>, IndexerError> {
    let mut output = Vec::new();
    let stem = media_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let media_directory = media_path.parent().unwrap_or(Path::new("."));
    for entry in storage.list_directory(title_path)? {
        if entry.kind != EntryKind::File || !is_image_name(&entry.name) {
            continue;
        }
        let base = file_stem_lower(&entry.name);
        let kind = if ["poster", "folder"].contains(&base.as_str()) || base.ends_with("-poster") {
            Some("poster")
        } else if ["fanart", "backdrop"].contains(&base.as_str()) || base.ends_with("-fanart") {
            Some("backdrop")
        } else {
            None
        };
        if let Some(kind) = kind {
            output.push(local_artwork(
                task,
                kind,
                &title_path.join(entry.name),
                false,
            ));
        }
    }
    if episode && media_directory != title_path {
        for entry in storage.list_directory(media_directory)? {
            if entry.kind == EntryKind::File
                && is_image_name(&entry.name)
                && file_stem_lower(&entry.name) == stem
            {
                output.push(local_artwork(
                    task,
                    "still",
                    &media_directory.join(entry.name),
                    true,
                ));
                break;
            }
        }
    }
    dedupe_artwork(&mut output);
    Ok(output)
}

fn local_artwork(
    task: &MediaScanTask,
    kind: &str,
    path: &Path,
    for_episode: bool,
) -> MediaArtworkInput {
    MediaArtworkInput {
        kind: kind.to_owned(),
        source: "local".to_owned(),
        cache_key: format!("local/{}/{}", task.source_id, path_text(path)),
        is_primary: true,
        for_episode,
        ..MediaArtworkInput::default()
    }
}

fn tmdb_artwork(kind: &str, key: &str, language: &str, for_episode: bool) -> MediaArtworkInput {
    let size = if kind == "poster" { "w500" } else { "w1280" };
    let file = key.rsplit('/').next().unwrap_or_default();
    MediaArtworkInput {
        kind: kind.to_owned(),
        source: "tmdb".to_owned(),
        source_url: Some(format!("https://image.tmdb.org/t/p/{size}/{file}")),
        cache_key: key.to_owned(),
        language: Some(language.to_owned()),
        is_primary: true,
        for_episode,
        ..MediaArtworkInput::default()
    }
}

fn dedupe_artwork(artwork: &mut Vec<MediaArtworkInput>) {
    artwork.sort_by(|left, right| left.cache_key.cmp(&right.cache_key));
    artwork.dedup_by(|left, right| left.cache_key == right.cache_key);
    let mut primary = HashMap::<String, bool>::new();
    for item in artwork {
        item.is_primary = !primary.insert(item.kind.clone(), true).unwrap_or(false);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedEpisode {
    title: String,
    season: i64,
    episode: i64,
}

fn parse_episode_name(stem: &str) -> Option<ParsedEpisode> {
    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b's' {
            continue;
        }
        let season_start = index + 1;
        let season_end = take_digits(bytes, season_start);
        if season_end == season_start || season_end >= bytes.len() || bytes[season_end] != b'e' {
            continue;
        }
        let episode_start = season_end + 1;
        let episode_end = take_digits(bytes, episode_start);
        if episode_end == episode_start {
            continue;
        }
        let season = lower[season_start..season_end].parse().ok()?;
        let episode = lower[episode_start..episode_end].parse().ok()?;
        let title = clean_title(&stem[..index]);
        return Some(ParsedEpisode {
            title: if title.is_empty() {
                "Unknown Series".to_owned()
            } else {
                title
            },
            season,
            episode,
        });
    }
    None
}

fn take_digits(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    index
}

fn parse_movie_name(stem: &str) -> (String, Option<i64>) {
    let bytes = stem.as_bytes();
    for index in (0..bytes.len().saturating_sub(3)).rev() {
        if bytes[index..index + 4]
            .iter()
            .all(|byte| byte.is_ascii_digit())
        {
            let candidate = &stem[index..index + 4];
            let year = candidate
                .parse::<i64>()
                .ok()
                .filter(|year| (1870..=2100).contains(year));
            if year.is_some() {
                let title = clean_title(&stem[..index]);
                if !title.is_empty() {
                    return (title, year);
                }
            }
        }
    }
    (clean_title(stem), None)
}

fn show_directory(media_path: &Path, source_path: &Path) -> PathBuf {
    let parent = media_path.parent().unwrap_or(source_path);
    let parent_name = parent
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if parent_name.starts_with("season ")
        || parent_name.starts_with("season.")
        || parent_name.starts_with("s0")
    {
        return parent.parent().unwrap_or(source_path).to_path_buf();
    }
    parent.to_path_buf()
}

fn clean_title(value: &str) -> String {
    value
        .replace(['.', '_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(['(', ')', '[', ']', ' '])
        .trim()
        .to_owned()
}

fn normalize_title(value: &str) -> String {
    clean_title(value).to_lowercase()
}

fn date_year(value: Option<&str>) -> Option<i64> {
    value?.get(..4)?.parse().ok()
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn is_image_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn file_stem_lower(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn video_mime(extension: &str) -> &'static str {
    match extension {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        _ => "video/x-matroska",
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn settings_language(task: &MediaScanTask) -> String {
    task.settings_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<MediaSettings>(json).ok())
        .map(|settings| settings.language)
        .unwrap_or_else(|| "zh-CN".to_owned())
}

fn invalid_nfo() -> IndexerError {
    IndexerError::new(ErrorCode::CorruptDocument, "NFO metadata is invalid", false)
}

fn tmdb_error(message: impl Into<String>) -> IndexerError {
    IndexerError::new(ErrorCode::CommandFailed, message, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_movie_title_and_year() {
        assert_eq!(
            parse_movie_name("Arrival.2016.2160p"),
            ("Arrival".to_owned(), Some(2016))
        );
        assert_eq!(parse_movie_name("无名之辈"), ("无名之辈".to_owned(), None));
    }

    #[test]
    fn parses_episode_number_case_insensitively() {
        assert_eq!(
            parse_episode_name("Slow.Horses.S03E07.2160p"),
            Some(ParsedEpisode {
                title: "Slow Horses".to_owned(),
                season: 3,
                episode: 7
            })
        );
    }

    #[test]
    fn nfo_fields_override_filename_metadata() {
        let parsed = parse_nfo(r#"<movie><title>本地标题</title><originaltitle>Local Title</originaltitle><year>2024</year><plot>Local plot</plot><runtime>128</runtime><genre>剧情</genre><uniqueid type="tmdb">42</uniqueid></movie>"#.as_bytes()).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("本地标题"));
        assert_eq!(parsed.original_title.as_deref(), Some("Local Title"));
        assert_eq!(parsed.year, Some(2024));
        assert_eq!(parsed.runtime_minutes, Some(128));
        assert_eq!(parsed.genres, vec!["剧情"]);
        assert_eq!(parsed.tmdb_id, Some(42));
    }

    #[test]
    fn tmdb_selection_rejects_ambiguous_results() {
        let result = TmdbSearchResult {
            id: 1,
            title: Some("Arrival".to_owned()),
            name: None,
            original_title: None,
            original_name: None,
            overview: None,
            release_date: Some("2016-11-11".to_owned()),
            first_air_date: None,
            original_language: Some("en".to_owned()),
            poster_path: None,
            backdrop_path: None,
        };
        assert!(matches!(
            select_tmdb_match(std::slice::from_ref(&result), "Arrival", Some(2016)),
            TmdbMatch::Matched(_, 1.0)
        ));
        assert!(matches!(
            select_tmdb_match(&[result.clone(), result], "Arrival", Some(2016)),
            TmdbMatch::Ambiguous
        ));
        assert!(matches!(
            select_tmdb_match(&[], "Missing", None),
            TmdbMatch::None
        ));
    }

    #[test]
    fn errors_never_include_tmdb_token() {
        let token = "secret-token";
        let error = tmdb_error("TMDB lookup failed");
        assert!(!error.message.contains(token));
    }
}
