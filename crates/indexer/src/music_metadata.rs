use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::probe::Probe;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::error::{ErrorCode, IndexerError};
use crate::storage::StoragePoolStorage;

const MAX_LYRICS: u64 = 256 * 1024;
const MAX_ARTWORK: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MusicMetadata {
    pub title: String,
    pub album: String,
    pub artists: Vec<String>,
    pub album_artists: Vec<String>,
    pub genres: Vec<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub duration_seconds: Option<f64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub musicbrainz_recording_id: Option<String>,
    pub musicbrainz_release_id: Option<String>,
    pub artwork_key: Option<String>,
    pub lyrics_text: Option<String>,
    pub lyrics_format: Option<String>,
}

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "mp3" | "flac" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "wav" | "aif" | "aiff"
            )
        })
}

fn album_directory(path: &Path) -> &Path {
    let parent = path.parent().unwrap_or(Path::new("."));
    let name = parent
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_disc = ["cd", "disc", "disk"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|rest| {
            let rest = rest.trim_matches([' ', '-', '_']);
            !rest.is_empty() && rest.chars().all(|value| value.is_ascii_digit())
        })
    });
    if is_disc {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    }
}

pub fn metadata_signature(
    storage: &StoragePoolStorage,
    path: &Path,
) -> Result<String, IndexerError> {
    let mut signature = format!("music-v1:{:?}", storage.identity_for(path)?);
    for sidecar in [path.with_extension("lrc"), path.with_extension("txt")] {
        if let Ok(identity) = storage.identity_for(&sidecar) {
            signature.push_str(&format!("{}:{identity:?}", sidecar.display()));
        }
    }
    for directory in [
        path.parent().unwrap_or(Path::new(".")),
        album_directory(path),
    ] {
        for name in [
            "cover.jpg",
            "cover.png",
            "folder.jpg",
            "folder.png",
            "Cover.jpg",
            "Folder.jpg",
        ] {
            if let Ok(identity) = storage.identity_for(&directory.join(name)) {
                signature.push_str(&format!("{}:{identity:?}", directory.join(name).display()));
            }
        }
    }
    Ok(format!("{:x}", Sha256::digest(signature.as_bytes())))
}

pub fn album_key(
    pool: &str,
    path: &Path,
    album: &str,
    artists: &[String],
    release_id: Option<&str>,
) -> String {
    let key = match release_id.filter(|value| !value.is_empty()) {
        Some(id) => format!("{pool}\0{}\0{id}", album_directory(path).display()),
        None => format!(
            "{pool}\0{}\0{album}\0{}",
            album_directory(path).display(),
            artists.join("\0")
        ),
    };
    format!("album-{:x}", Sha256::digest(key.as_bytes()))
}

fn strings(tag: &lofty::tag::Tag, preferred: ItemKey, fallback: ItemKey) -> Vec<String> {
    let primary: Vec<&str> = tag.get_strings(preferred).collect();
    let values = if primary.is_empty() {
        tag.get_strings(fallback).collect()
    } else {
        primary
    };
    let mut values: Vec<String> = values
        .into_iter()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(1024).collect())
        .collect();
    let mut unique = Vec::new();
    for value in values.drain(..).take(64) {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

fn text(tag: &lofty::tag::Tag, key: ItemKey) -> Option<String> {
    tag.get_string(key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(4096).collect())
}

fn read_tags(file: File) -> (MusicMetadata, Option<Vec<u8>>) {
    let mut metadata = MusicMetadata::default();
    let tagged = Probe::new(BufReader::new(file))
        .guess_file_type()
        .ok()
        .and_then(|probe| probe.read().ok());
    let Some(tagged) = tagged else {
        return (metadata, None);
    };
    let properties = tagged.properties();
    let duration = properties.duration().as_secs_f64();
    metadata.duration_seconds = (duration > 0.0).then_some(duration);
    metadata.bitrate = properties.audio_bitrate();
    metadata.sample_rate = properties.sample_rate();
    metadata.bit_depth = properties.bit_depth();
    let mut picture = None;
    for tag in tagged.primary_tag().into_iter().chain(tagged.tags().iter()) {
        if metadata.title.is_empty() {
            metadata.title = tag
                .title()
                .map(|value| value.chars().take(4096).collect())
                .unwrap_or_default();
        }
        if metadata.album.is_empty() {
            metadata.album = tag
                .album()
                .map(|value| value.chars().take(4096).collect())
                .unwrap_or_default();
        }
        if metadata.artists.is_empty() {
            metadata.artists = strings(tag, ItemKey::TrackArtists, ItemKey::TrackArtist);
        }
        if metadata.album_artists.is_empty() {
            metadata.album_artists = strings(tag, ItemKey::AlbumArtists, ItemKey::AlbumArtist);
        }
        if metadata.genres.is_empty() {
            metadata.genres = strings(tag, ItemKey::Genre, ItemKey::Genre);
        }
        metadata.year = metadata.year.or_else(|| {
            tag.get_string(ItemKey::RecordingDate)
                .or_else(|| tag.get_string(ItemKey::Year))
                .and_then(|value| value.get(..4))
                .and_then(|value| value.parse().ok())
        });
        metadata.track_number = metadata.track_number.or(tag.track());
        metadata.disc_number = metadata.disc_number.or(tag.disk());
        metadata.musicbrainz_recording_id = metadata
            .musicbrainz_recording_id
            .or_else(|| text(tag, ItemKey::MusicBrainzRecordingId));
        metadata.musicbrainz_release_id = metadata
            .musicbrainz_release_id
            .or_else(|| text(tag, ItemKey::MusicBrainzReleaseId));
        if metadata.lyrics_text.is_none() {
            metadata.lyrics_text = tag
                .get_string(ItemKey::Lyrics)
                .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
                .map(|value| value.chars().take(MAX_LYRICS as usize).collect());
        }
        if picture.is_none() {
            picture = tag
                .pictures()
                .iter()
                .find(|picture| picture.data().len() <= MAX_ARTWORK as usize)
                .map(|picture| picture.data().to_vec());
        }
    }
    (metadata, picture)
}

pub async fn read_metadata(
    storage: &StoragePoolStorage,
    path: &Path,
    artwork_root: &Path,
) -> Result<MusicMetadata, IndexerError> {
    let file = storage.open_file(path)?;
    let before = StoragePoolStorage::file_identity(&file)?;
    let tag_file = file.try_clone().map_err(IndexerError::storage)?;
    let (mut metadata, mut picture) = tokio::task::spawn_blocking(move || read_tags(tag_file))
        .await
        .map_err(|error| IndexerError::internal(error.to_string()))?;
    if metadata.duration_seconds.is_none() {
        let mut probe_file = file.try_clone().map_err(IndexerError::storage)?;
        probe_file
            .seek(SeekFrom::Start(0))
            .map_err(IndexerError::storage)?;
        if let Ok(bytes) = run_tool(
            "ffprobe",
            &[
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                "pipe:0",
                "-show_entries",
                "format=duration:stream=sample_rate,bits_per_raw_sample,bit_rate",
                "-of",
                "json",
            ],
            probe_file,
            64 * 1024,
        )
        .await
            && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        {
            metadata.duration_seconds = value["format"]["duration"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0);
            if let Some(stream) = value["streams"]
                .as_array()
                .and_then(|streams| streams.first())
            {
                metadata.sample_rate = metadata.sample_rate.or_else(|| {
                    stream["sample_rate"]
                        .as_str()
                        .and_then(|value| value.parse().ok())
                });
            }
        }
    }
    if metadata.title.trim().is_empty() {
        metadata.title = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
    }
    if metadata.album.trim().is_empty() {
        metadata.album = album_directory(path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Unknown album".into());
    }
    if metadata.artists.is_empty() {
        metadata.artists.push("Unknown artist".into());
    }
    if metadata.album_artists.is_empty() {
        metadata.album_artists = metadata.artists.clone();
    }
    for extension in ["lrc", "txt"] {
        let sidecar = path.with_extension(extension);
        if let Ok(file) = storage.open_file(&sidecar)
            && file.metadata().is_ok_and(|value| value.len() <= MAX_LYRICS)
        {
            let mut bytes = Vec::new();
            file.take(MAX_LYRICS + 1)
                .read_to_end(&mut bytes)
                .map_err(IndexerError::storage)?;
            if bytes.len() <= MAX_LYRICS as usize {
                metadata.lyrics_text = Some(String::from_utf8_lossy(&bytes).into_owned());
                metadata.lyrics_format = Some(extension.replace("txt", "text"));
                break;
            }
        }
    }
    if metadata.lyrics_format.is_none()
        && let Some(lyrics) = &metadata.lyrics_text
    {
        metadata.lyrics_format = Some(
            if lyrics
                .lines()
                .any(|line| line.starts_with('[') && line.contains(':'))
            {
                "lrc"
            } else {
                "text"
            }
            .into(),
        );
    }
    if picture.is_none() {
        for directory in [
            path.parent().unwrap_or(Path::new(".")),
            album_directory(path),
        ] {
            for name in [
                "cover.jpg",
                "cover.png",
                "folder.jpg",
                "folder.png",
                "Cover.jpg",
                "Folder.jpg",
            ] {
                if let Ok(file) = storage.open_file(&directory.join(name))
                    && file
                        .metadata()
                        .is_ok_and(|value| value.len() <= MAX_ARTWORK)
                {
                    let mut bytes = Vec::new();
                    file.take(MAX_ARTWORK + 1)
                        .read_to_end(&mut bytes)
                        .map_err(IndexerError::storage)?;
                    if bytes.len() <= MAX_ARTWORK as usize {
                        picture = Some(bytes);
                        break;
                    }
                }
            }
            if picture.is_some() {
                break;
            }
        }
    }
    if let Some(bytes) = picture {
        metadata.artwork_key = cache_artwork(bytes, artwork_root).await.ok();
    }
    if StoragePoolStorage::file_identity(&file)? != before {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            "Music file changed during metadata extraction",
            true,
        ));
    }
    Ok(metadata)
}

async fn cache_artwork(bytes: Vec<u8>, root: &Path) -> Result<String, IndexerError> {
    let key = format!("{:x}.jpg", Sha256::digest(&bytes));
    let destination = root.join(&key);
    if destination.is_file() {
        return Ok(key);
    }
    let mut input = tempfile::tempfile().map_err(IndexerError::storage)?;
    input.write_all(&bytes).map_err(IndexerError::storage)?;
    input
        .seek(SeekFrom::Start(0))
        .map_err(IndexerError::storage)?;
    let jpeg = run_tool(
        "ffmpeg",
        &[
            "-v",
            "error",
            "-nostdin",
            "-max_alloc",
            "33554432",
            "-protocol_whitelist",
            "file,pipe",
            "-threads",
            "1",
            "-max_pixels",
            "16777216",
            "-i",
            "pipe:0",
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ],
        input,
        2 * 1024 * 1024,
    )
    .await?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(IndexerError::storage)?;
    let temporary = root.join(format!(".{key}-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, jpeg)
        .await
        .map_err(IndexerError::storage)?;
    tokio::fs::rename(&temporary, destination)
        .await
        .map_err(IndexerError::storage)?;
    Ok(key)
}

async fn run_tool(
    program: &str,
    args: &[&str],
    input: File,
    limit: usize,
) -> Result<Vec<u8>, IndexerError> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::from(input))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(IndexerError::storage)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| IndexerError::internal("Music extractor stdout unavailable"))?
        .take(limit as u64 + 1);
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(IndexerError::storage)?;
        if bytes.len() > limit {
            return Err(IndexerError::new(
                ErrorCode::SizeLimit,
                "Music extractor output exceeds limit",
                false,
            ));
        }
        let status = child.wait().await.map_err(IndexerError::storage)?;
        if !status.success() {
            return Err(IndexerError::new(
                ErrorCode::CommandFailed,
                "Music extractor could not read this file",
                false,
            ));
        }
        Ok(bytes)
    };
    match tokio::time::timeout(Duration::from_secs(15), operation).await {
        Ok(result) => result,
        Err(_) => Err(IndexerError::new(
            ErrorCode::CommandTimeout,
            "Music extraction timed out",
            true,
        )),
    }
}
