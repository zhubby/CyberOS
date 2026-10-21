use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::command::{CommandLimits, CommandRunner, child_media_path};
use crate::db::ProcessingSettings;
use crate::error::{ErrorCode, PhotostaffError};
use crate::storage::FileIdentity;

const PIPELINE_VERSION: u32 = 1;
const METADATA_SCHEMA_VERSION: u32 = 2;
const MAX_METADATA_LEAVES: usize = 4096;
const MAX_METADATA_SCALAR_BYTES: usize = 64 * 1024;
const MAX_METADATA_JSON_BYTES: usize = 512 * 1024;
const MAX_METADATA_DEPTH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataValue {
    pub source: String,
    pub key: String,
    pub value_type: String,
    pub text_value: Option<String>,
    pub number_value: Option<f64>,
    pub date_value: Option<String>,
    pub boolean_value: Option<bool>,
    pub sensitive: bool,
    pub ordinal: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataRecord {
    pub schema_version: u32,
    pub status: String,
    pub media_kind: MediaKind,
    pub captured_at: Option<String>,
    pub captured_at_local: Option<String>,
    pub capture_offset_minutes: Option<i32>,
    pub capture_source: String,
    pub duration_ms: Option<u64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub software: Option<String>,
    pub body_serial: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
    pub lens_serial: Option<String>,
    pub iso: Option<f64>,
    pub exposure_time_seconds: Option<f64>,
    pub aperture: Option<f64>,
    pub focal_length_mm: Option<f64>,
    pub focal_length_35_mm: Option<f64>,
    pub exposure_bias_ev: Option<f64>,
    pub exposure_program: Option<String>,
    pub metering_mode: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub creator: Option<String>,
    pub copyright: Option<String>,
    pub rating: Option<f64>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub gps_altitude_m: Option<f64>,
    pub gps_direction_deg: Option<f64>,
    pub raw_metadata: BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    pub warnings: Vec<String>,
    pub keywords: Vec<String>,
    pub values: Vec<MetadataValue>,
    pub sidecar_path: Option<String>,
    pub sidecar_size_bytes: Option<u64>,
    pub sidecar_mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedMedia {
    pub content_hash: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub orientation: Option<i32>,
    pub taken_at: String,
    pub taken_at_source: String,
    pub thumbnail_key: String,
    pub preview_key: String,
    pub thumbnail_temp_path: PathBuf,
    pub thumbnail_path: PathBuf,
    pub thumbnail_identity: FileIdentity,
    pub preview_temp_path: PathBuf,
    pub preview_path: PathBuf,
    pub preview_identity: FileIdentity,
    pub metadata: MetadataRecord,
}

#[derive(Debug, Clone)]
pub struct Sidecar<'a> {
    pub file: &'a File,
    pub path: String,
    pub identity: FileIdentity,
}

#[derive(Default)]
struct TemporaryFiles {
    paths: Vec<PathBuf>,
}

impl TemporaryFiles {
    fn track(&mut self, path: &Path) {
        self.paths.push(path.to_owned());
    }

    fn keep(&mut self, path: &Path) {
        self.paths.retain(|candidate| candidate != path);
    }
}

impl Drop for TemporaryFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
}

pub async fn process_media(
    source: &mut File,
    source_name: &str,
    source_identity: FileIdentity,
    sidecar: Option<Sidecar<'_>>,
    cache_root: &Path,
    settings: &ProcessingSettings,
    runner: &CommandRunner,
) -> Result<ProcessedMedia, PhotostaffError> {
    if source_identity.size > settings.max_file_size_bytes {
        return Err(PhotostaffError::new(
            ErrorCode::SizeLimit,
            "Media exceeds the configured size limit",
            false,
        ));
    }
    let candidate = candidate_kind(source_name).ok_or_else(|| {
        PhotostaffError::new(
            ErrorCode::UnsupportedMedia,
            "Unsupported media extension",
            false,
        )
    })?;
    let content_hash = hash_file(source).await?;
    verify_identity(source, source_identity)?;
    let limits = command_limits(settings);
    let embedded = exiftool(source, runner, &limits).await?;
    let detected = detect_kind(candidate, &embedded)?;
    if detected != candidate {
        return Err(PhotostaffError::new(
            ErrorCode::UnsupportedMedia,
            "Media content does not match its extension",
            false,
        ));
    }
    let mime_type = json_string(&embedded, &["MIMEType", "File:MIMEType"])
        .unwrap_or_else(|| mime_for_name(source_name).to_owned());
    let mut warnings = Vec::new();
    let sidecar_json = if let Some(sidecar) = &sidecar {
        if sidecar.identity.size > settings.max_xmp_size_bytes {
            warnings.push("XMP sidecar exceeds the configured size limit".to_owned());
            None
        } else {
            Some(exiftool(sidecar.file, runner, &limits).await?)
        }
    } else {
        None
    };
    let probe = if detected == MediaKind::Video {
        Some(ffprobe(source, runner, &limits).await?)
    } else {
        None
    };
    let metadata = normalize_metadata(
        detected,
        embedded,
        sidecar_json,
        probe.as_ref(),
        source_identity.mtime_ns,
        sidecar.as_ref(),
        warnings,
    );
    let (mut width, mut height) = dimensions(&metadata.raw_metadata, probe.as_ref())?;
    let orientation = metadata_number(
        &metadata.raw_metadata,
        &["EXIF:Orientation", "IFD0:Orientation"],
    )
    .map(|value| value as i32);
    if matches!(orientation, Some(5..=8)) {
        std::mem::swap(&mut width, &mut height);
    }
    validate_pixel_limit(width, height, settings.max_decoded_pixels)?;

    let scratch = cache_root.join("scratch");
    let thumbnail_dir = cache_root.join("thumbnail");
    let preview_dir = cache_root.join("preview");
    for directory in [&scratch, &thumbnail_dir, &preview_dir] {
        std::fs::create_dir_all(directory).map_err(PhotostaffError::storage)?;
    }
    let thumbnail_key = derivative_key(&content_hash, "thumbnail", "512-cover-attention-q80");
    let preview_key = derivative_key(&content_hash, "preview", "2048-inside-q85");
    let thumbnail_path = cache_root.join(&thumbnail_key);
    let preview_path = cache_root.join(&preview_key);
    let thumbnail_temp_path = thumbnail_dir.join(format!(
        ".{}.{}.tmp",
        thumbnail_path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let preview_temp_path = preview_dir.join(format!(
        ".{}.{}.tmp",
        preview_path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let mut temporary_files = TemporaryFiles::default();
    temporary_files.track(&thumbnail_temp_path);
    temporary_files.track(&preview_temp_path);

    let decoded_path = match detected {
        MediaKind::Image if is_heif(source_name) => {
            let output = scratch.join(format!("{}.jpg", Uuid::new_v4()));
            temporary_files.track(&output);
            runner
                .run(
                    "heif-convert",
                    &[
                        child_media_path().into(),
                        output.to_string_lossy().into_owned(),
                    ],
                    Some(source),
                    &limits,
                )
                .await?;
            Some(output)
        }
        MediaKind::Raw => {
            let output = scratch.join(format!("{}.tiff", Uuid::new_v4()));
            temporary_files.track(&output);
            runner
                .run(
                    "dcraw_emu",
                    &[
                        "-w".into(),
                        "-T".into(),
                        "-O".into(),
                        output.to_string_lossy().into_owned(),
                        child_media_path().into(),
                    ],
                    Some(source),
                    &limits,
                )
                .await?;
            Some(output)
        }
        MediaKind::Video => {
            let output = scratch.join(format!("{}.jpg", Uuid::new_v4()));
            temporary_files.track(&output);
            runner
                .run(
                    "ffmpeg",
                    &[
                        "-hide_banner".into(),
                        "-loglevel".into(),
                        "error".into(),
                        "-y".into(),
                        "-ss".into(),
                        "00:00:01".into(),
                        "-i".into(),
                        child_media_path().into(),
                        "-frames:v".into(),
                        "1".into(),
                        "-q:v".into(),
                        "2".into(),
                        output.to_string_lossy().into_owned(),
                    ],
                    Some(source),
                    &limits,
                )
                .await?;
            Some(output)
        }
        MediaKind::Image => None,
    };
    let derivative_input = derivative_input(decoded_path.as_deref(), &mime_type);
    render_derivative(
        runner,
        source,
        &limits,
        &derivative_input,
        &thumbnail_temp_path,
        "512x512",
        Some("attention"),
        80,
    )
    .await?;
    render_derivative(
        runner,
        source,
        &limits,
        &derivative_input,
        &preview_temp_path,
        "2048x2048",
        None,
        85,
    )
    .await?;
    validate_derivative(
        &thumbnail_temp_path,
        settings.max_intermediate_bytes,
        runner,
        &limits,
    )
    .await?;
    validate_derivative(
        &preview_temp_path,
        settings.max_intermediate_bytes,
        runner,
        &limits,
    )
    .await?;
    let thumbnail_identity = FileIdentity::from_file(
        &File::open(&thumbnail_temp_path).map_err(PhotostaffError::storage)?,
    )?;
    let preview_identity = FileIdentity::from_file(
        &File::open(&preview_temp_path).map_err(PhotostaffError::storage)?,
    )?;

    verify_identity(source, source_identity)?;
    if let Some(sidecar) = &sidecar {
        verify_identity(sidecar.file, sidecar.identity)?;
    }
    let taken_at = metadata
        .captured_at
        .clone()
        .or_else(|| metadata.captured_at_local.clone())
        .unwrap_or_else(|| iso_from_ns(source_identity.mtime_ns));
    let taken_at_source = if metadata.capture_source == "file_mtime" {
        "file_mtime"
    } else {
        "exif"
    }
    .to_owned();
    temporary_files.keep(&thumbnail_temp_path);
    temporary_files.keep(&preview_temp_path);
    Ok(ProcessedMedia {
        content_hash,
        mime_type,
        width,
        height,
        orientation,
        taken_at,
        taken_at_source,
        thumbnail_key,
        preview_key,
        thumbnail_temp_path,
        thumbnail_path,
        thumbnail_identity,
        preview_temp_path,
        preview_path,
        preview_identity,
        metadata,
    })
}

pub fn candidate_kind(name: &str) -> Option<MediaKind> {
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "heic" | "heif" => Some(MediaKind::Image),
        "mp4" | "mov" | "m4v" | "avi" | "mkv" | "webm" | "mpeg" | "mpg" => Some(MediaKind::Video),
        "cr2" | "cr3" | "crw" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "dng" | "raf" | "orf"
        | "rw2" | "pef" | "rwl" | "3fr" | "x3f" | "erf" | "kdc" | "mos" | "mrw" | "bay" => {
            Some(MediaKind::Raw)
        }
        _ => None,
    }
}

pub fn sidecar_associations(names: &[String]) -> BTreeMap<String, Result<Option<String>, String>> {
    let mut actual = BTreeMap::new();
    for name in names {
        actual
            .entry(name.to_lowercase())
            .or_insert_with(Vec::new)
            .push(name.clone());
    }
    let media: Vec<_> = names
        .iter()
        .filter(|name| candidate_kind(name).is_some())
        .cloned()
        .collect();
    let mut by_stem: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in &media {
        let stem = Path::new(name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        by_stem.entry(stem).or_default().push(name.clone());
    }
    let mut result = BTreeMap::new();
    for name in media {
        let exact_key = format!("{name}.xmp").to_lowercase();
        if let Some(candidates) = actual.get(&exact_key) {
            result.insert(
                name,
                if candidates.len() == 1 {
                    Ok(Some(candidates[0].clone()))
                } else {
                    Err("Ambiguous XMP sidecar name".into())
                },
            );
            continue;
        }
        let stem = Path::new(&name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        let xmp_key = format!("{stem}.xmp");
        let Some(candidates) = actual.get(&xmp_key) else {
            continue;
        };
        let siblings = by_stem.get(&stem).cloned().unwrap_or_default();
        let raw: Vec<_> = siblings
            .iter()
            .filter(|item| candidate_kind(item) == Some(MediaKind::Raw))
            .collect();
        if candidates.len() != 1 || (siblings.len() > 1 && !(raw.len() == 1 && raw[0] == &name)) {
            result.insert(name, Err("Ambiguous XMP sidecar was not attached".into()));
        } else {
            result.insert(name, Ok(Some(candidates[0].clone())));
        }
    }
    result
}

fn command_limits(settings: &ProcessingSettings) -> CommandLimits {
    CommandLimits {
        timeout: Duration::from_millis(settings.command_timeout_ms),
        max_stdout_bytes: 1024 * 1024,
        max_file_bytes: settings.max_intermediate_bytes,
        max_address_space_bytes: 4 * 1024 * 1024 * 1024,
    }
}

async fn exiftool(
    file: &File,
    runner: &CommandRunner,
    limits: &CommandLimits,
) -> Result<Value, PhotostaffError> {
    let output = runner
        .run(
            "exiftool",
            &[
                "-j".into(),
                "-G1".into(),
                "-struct".into(),
                "-n".into(),
                child_media_path().into(),
            ],
            Some(file),
            limits,
        )
        .await?;
    let mut values: Vec<Value> = serde_json::from_slice(&output.stdout).map_err(|_| {
        PhotostaffError::new(
            ErrorCode::CorruptMedia,
            "ExifTool returned invalid JSON",
            false,
        )
    })?;
    values.pop().ok_or_else(|| {
        PhotostaffError::new(
            ErrorCode::CorruptMedia,
            "ExifTool returned no media record",
            false,
        )
    })
}

async fn ffprobe(
    file: &File,
    runner: &CommandRunner,
    limits: &CommandLimits,
) -> Result<Value, PhotostaffError> {
    let output = runner
        .run(
            "ffprobe",
            &[
                "-v".into(),
                "error".into(),
                "-show_format".into(),
                "-show_streams".into(),
                "-of".into(),
                "json".into(),
                child_media_path().into(),
            ],
            Some(file),
            limits,
        )
        .await?;
    serde_json::from_slice(&output.stdout).map_err(|_| {
        PhotostaffError::new(
            ErrorCode::CorruptMedia,
            "ffprobe returned invalid JSON",
            false,
        )
    })
}

fn detect_kind(candidate: MediaKind, exif: &Value) -> Result<MediaKind, PhotostaffError> {
    let mime = json_string(exif, &["MIMEType", "File:MIMEType"]).unwrap_or_default();
    let file_type = json_string(exif, &["FileType", "File:FileType"])
        .unwrap_or_default()
        .to_ascii_uppercase();
    if mime.starts_with("video/") {
        return Ok(MediaKind::Video);
    }
    if matches!(
        file_type.as_str(),
        "CR2"
            | "CR3"
            | "NEF"
            | "NRW"
            | "ARW"
            | "DNG"
            | "RAF"
            | "ORF"
            | "RW2"
            | "PEF"
            | "RWL"
            | "3FR"
            | "X3F"
            | "ERF"
            | "KDC"
            | "MOS"
            | "MRW"
            | "BAY"
    ) {
        return Ok(MediaKind::Raw);
    }
    if mime.starts_with("image/") {
        return Ok(MediaKind::Image);
    }
    if candidate == MediaKind::Video {
        return Ok(MediaKind::Video);
    }
    Err(PhotostaffError::new(
        ErrorCode::UnsupportedMedia,
        "Media format could not be verified",
        false,
    ))
}

fn validate_pixel_limit(width: u32, height: u32, limit: u64) -> Result<(), PhotostaffError> {
    if u64::from(width).saturating_mul(u64::from(height)) > limit {
        return Err(PhotostaffError::new(
            ErrorCode::SizeLimit,
            "Decoded media exceeds the pixel limit",
            false,
        ));
    }
    Ok(())
}

fn derivative_input(decoded_path: Option<&Path>, mime_type: &str) -> PathBuf {
    decoded_path.map(Path::to_path_buf).unwrap_or_else(|| {
        if mime_type == "image/gif" {
            PathBuf::from(format!("{}[n=-1]", child_media_path()))
        } else {
            PathBuf::from(child_media_path())
        }
    })
}

#[allow(clippy::too_many_arguments)]
async fn render_derivative(
    runner: &CommandRunner,
    source: &File,
    limits: &CommandLimits,
    input: &Path,
    output: &Path,
    size: &str,
    crop: Option<&str>,
    quality: u8,
) -> Result<(), PhotostaffError> {
    let mut arguments = vec![
        input.to_string_lossy().into_owned(),
        "--size".into(),
        size.into(),
        "--rotate".into(),
        "--strip".into(),
    ];
    if let Some(crop) = crop {
        arguments.extend(["--crop".into(), crop.into()]);
    }
    arguments.extend([
        "--output".into(),
        format!("{}[Q={quality}]", output.display()),
    ]);
    runner
        .run("vipsthumbnail", &arguments, Some(source), limits)
        .await?;
    Ok(())
}

async fn validate_derivative(
    path: &Path,
    limit: u64,
    runner: &CommandRunner,
    limits: &CommandLimits,
) -> Result<(), PhotostaffError> {
    let sync_path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .read(true)
            .open(sync_path)
            .map_err(PhotostaffError::storage)?;
        let metadata = file.metadata().map_err(PhotostaffError::storage)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(PhotostaffError::new(
                ErrorCode::CorruptMedia,
                "Media tool produced an empty derivative",
                false,
            ));
        }
        if metadata.len() > limit {
            return Err(PhotostaffError::new(
                ErrorCode::SizeLimit,
                "Derivative exceeds the intermediate size limit",
                false,
            ));
        }
        file.sync_all().map_err(PhotostaffError::storage)
    })
    .await
    .map_err(|error| PhotostaffError::internal(error.to_string()))??;
    runner
        .run(
            "vipsheader",
            &["-a".into(), path.to_string_lossy().into_owned()],
            None,
            limits,
        )
        .await?;
    Ok(())
}

async fn hash_file(file: &File) -> Result<String, PhotostaffError> {
    let file = file.try_clone().map_err(PhotostaffError::storage)?;
    tokio::task::spawn_blocking(move || hash_file_blocking(&file))
        .await
        .map_err(|error| PhotostaffError::internal(error.to_string()))?
}

fn hash_file_blocking(file: &File) -> Result<String, PhotostaffError> {
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    let mut offset = 0_u64;
    loop {
        let count = file
            .read_at(&mut buffer, offset)
            .map_err(PhotostaffError::storage)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        offset = offset.saturating_add(count as u64);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn verify_identity(file: &File, expected: FileIdentity) -> Result<(), PhotostaffError> {
    if FileIdentity::from_file(file)? != expected {
        return Err(PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Media source changed during processing",
            false,
        ));
    }
    Ok(())
}

fn derivative_key(content_hash: &str, purpose: &str, parameters: &str) -> String {
    let digest = Sha256::digest(
        format!("{content_hash}|{purpose}|{parameters}|{PIPELINE_VERSION}").as_bytes(),
    );
    format!("{purpose}/{digest:x}.webp")
}

fn normalize_metadata(
    kind: MediaKind,
    embedded: Value,
    sidecar: Option<Value>,
    probe: Option<&Value>,
    mtime_ns: i64,
    sidecar_input: Option<&Sidecar<'_>>,
    mut warnings: Vec<String>,
) -> MetadataRecord {
    let mut groups = BTreeMap::new();
    let mut values = Vec::new();
    sanitize_object(&embedded, None, &mut groups, &mut values, &mut warnings);
    if let Some(sidecar) = sidecar {
        sanitize_object(
            &sidecar,
            Some("sidecar_xmp"),
            &mut groups,
            &mut values,
            &mut warnings,
        );
    }
    if let Some(probe) = probe {
        sanitize_object(
            probe,
            Some("video"),
            &mut groups,
            &mut values,
            &mut warnings,
        );
    }
    let (captured_at, captured_at_local, capture_offset_minutes, capture_source) =
        capture_time(&groups, mtime_ns);
    let keywords = metadata_strings(
        &groups,
        &["XMP:Subject", "IPTC:Keywords", "sidecar_xmp:XMP:Subject"],
    )
    .into_iter()
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect();
    let video_stream = probe
        .and_then(|value| value.get("streams"))
        .and_then(Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        });
    let audio_stream = probe
        .and_then(|value| value.get("streams"))
        .and_then(Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        });
    let duration_ms = probe
        .and_then(|value| value.pointer("/format/duration"))
        .and_then(number_value)
        .map(|value| (value * 1000.0).max(0.0) as u64);
    MetadataRecord {
        schema_version: METADATA_SCHEMA_VERSION,
        status: if warnings.is_empty() {
            "ready"
        } else {
            "partial"
        }
        .into(),
        media_kind: kind,
        captured_at,
        captured_at_local,
        capture_offset_minutes,
        capture_source,
        duration_ms,
        container: probe
            .and_then(|value| value.pointer("/format/format_name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        video_codec: video_stream
            .and_then(|value| value.get("codec_name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        audio_codec: audio_stream
            .and_then(|value| value.get("codec_name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        camera_make: metadata_string(&groups, &["EXIF:Make", "IFD0:Make", "XMP:Make"]),
        camera_model: metadata_string(&groups, &["EXIF:Model", "IFD0:Model", "XMP:Model"]),
        software: metadata_string(
            &groups,
            &["EXIF:Software", "IFD0:Software", "XMP:CreatorTool"],
        ),
        body_serial: metadata_string(
            &groups,
            &["EXIF:BodySerialNumber", "MakerNotes:SerialNumber"],
        ),
        lens_make: metadata_string(&groups, &["EXIF:LensMake", "XMP:LensMake"]),
        lens_model: metadata_string(&groups, &["EXIF:LensModel", "XMP:Lens", "Composite:LensID"]),
        lens_serial: metadata_string(&groups, &["EXIF:LensSerialNumber", "XMP:LensSerialNumber"]),
        iso: metadata_number(&groups, &["EXIF:ISO", "EXIF:ISOSpeedRatings"]),
        exposure_time_seconds: metadata_number(&groups, &["EXIF:ExposureTime"]),
        aperture: metadata_number(&groups, &["EXIF:FNumber", "EXIF:ApertureValue"]),
        focal_length_mm: metadata_number(&groups, &["EXIF:FocalLength"]),
        focal_length_35_mm: metadata_number(&groups, &["EXIF:FocalLengthIn35mmFormat"]),
        exposure_bias_ev: metadata_number(
            &groups,
            &["EXIF:ExposureCompensation", "EXIF:ExposureBiasValue"],
        ),
        exposure_program: metadata_string(&groups, &["EXIF:ExposureProgram"]),
        metering_mode: metadata_string(&groups, &["EXIF:MeteringMode"]),
        flash: metadata_string(&groups, &["EXIF:Flash"]),
        white_balance: metadata_string(&groups, &["EXIF:WhiteBalance"]),
        title: metadata_string(
            &groups,
            &["sidecar_xmp:XMP:Title", "XMP:Title", "IPTC:ObjectName"],
        ),
        description: metadata_string(
            &groups,
            &[
                "sidecar_xmp:XMP:Description",
                "XMP:Description",
                "IPTC:Caption-Abstract",
                "EXIF:ImageDescription",
            ],
        ),
        creator: metadata_string(
            &groups,
            &[
                "sidecar_xmp:XMP:Creator",
                "XMP:Creator",
                "IPTC:By-line",
                "EXIF:Artist",
            ],
        ),
        copyright: metadata_string(
            &groups,
            &["sidecar_xmp:XMP:Rights", "XMP:Rights", "EXIF:Copyright"],
        ),
        rating: metadata_number(&groups, &["sidecar_xmp:XMP:Rating", "XMP:Rating"]),
        gps_latitude: bounded(
            metadata_number(
                &groups,
                &[
                    "Composite:GPSLatitude",
                    "EXIF:GPSLatitude",
                    "XMP:GPSLatitude",
                ],
            ),
            -90.0,
            90.0,
        ),
        gps_longitude: bounded(
            metadata_number(
                &groups,
                &[
                    "Composite:GPSLongitude",
                    "EXIF:GPSLongitude",
                    "XMP:GPSLongitude",
                ],
            ),
            -180.0,
            180.0,
        ),
        gps_altitude_m: metadata_number(&groups, &["Composite:GPSAltitude", "EXIF:GPSAltitude"]),
        gps_direction_deg: metadata_number(&groups, &["EXIF:GPSImgDirection"]),
        raw_metadata: groups,
        warnings,
        keywords,
        values,
        sidecar_path: sidecar_input.map(|item| item.path.clone()),
        sidecar_size_bytes: sidecar_input.map(|item| item.identity.size),
        sidecar_mtime_ms: sidecar_input.map(|item| item.identity.mtime_ns / 1_000_000),
    }
}

fn sanitize_object(
    value: &Value,
    source_override: Option<&str>,
    groups: &mut BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    values: &mut Vec<MetadataValue>,
    warnings: &mut Vec<String>,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    let mut leaves = values.len();
    let mut bytes = serde_json::to_vec(groups).map_or(0, |value| value.len());
    for (key, value) in object {
        if key == "SourceFile" || omitted_key(key) {
            continue;
        }
        let (group, field) = source_override
            .map(|source| (source.to_owned(), key.clone()))
            .unwrap_or_else(|| {
                key.split_once(':')
                    .map(|(group, field)| (group.to_ascii_lowercase(), field.to_owned()))
                    .unwrap_or_else(|| ("file".into(), key.clone()))
            });
        flatten_value(
            &group,
            &field,
            value,
            0,
            groups,
            values,
            warnings,
            &mut leaves,
            &mut bytes,
        );
        if leaves >= MAX_METADATA_LEAVES || bytes >= MAX_METADATA_JSON_BYTES {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn flatten_value(
    source: &str,
    path: &str,
    value: &Value,
    depth: usize,
    groups: &mut BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    values: &mut Vec<MetadataValue>,
    warnings: &mut Vec<String>,
    leaves: &mut usize,
    bytes: &mut usize,
) {
    if depth > MAX_METADATA_DEPTH
        || *leaves >= MAX_METADATA_LEAVES
        || *bytes >= MAX_METADATA_JSON_BYTES
    {
        if !warnings
            .iter()
            .any(|warning| warning == "Metadata was truncated")
        {
            warnings.push("Metadata was truncated".into());
        }
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                flatten_value(
                    source,
                    path,
                    item,
                    depth + 1,
                    groups,
                    values,
                    warnings,
                    leaves,
                    bytes,
                );
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                if !omitted_key(key) {
                    flatten_value(
                        source,
                        &format!("{path}.{key}"),
                        item,
                        depth + 1,
                        groups,
                        values,
                        warnings,
                        leaves,
                        bytes,
                    );
                }
            }
        }
        Value::Null => {}
        scalar => {
            let mut scalar = scalar.clone();
            if let Value::String(text) = &scalar
                && text.len() > MAX_METADATA_SCALAR_BYTES
            {
                scalar = Value::String(text.chars().take(MAX_METADATA_SCALAR_BYTES).collect());
                warnings.push("Metadata scalar was truncated".into());
            }
            let scalar_bytes = serde_json::to_vec(&scalar).map_or(0, |value| value.len());
            if *bytes + scalar_bytes > MAX_METADATA_JSON_BYTES {
                return;
            }
            let list = groups
                .entry(source.to_owned())
                .or_default()
                .entry(path.to_owned())
                .or_default();
            let ordinal = list.len();
            list.push(scalar.clone());
            let key = format!("{source}:{path}");
            let sensitive = sensitive_key(&key);
            values.push(metadata_value(source, &key, scalar, sensitive, ordinal));
            *leaves += 1;
            *bytes += scalar_bytes;
        }
    }
}

fn metadata_value(
    source: &str,
    key: &str,
    value: Value,
    sensitive: bool,
    ordinal: usize,
) -> MetadataValue {
    match value {
        Value::Bool(value) => MetadataValue {
            source: source.into(),
            key: key.into(),
            value_type: "boolean".into(),
            text_value: None,
            number_value: None,
            date_value: None,
            boolean_value: Some(value),
            sensitive,
            ordinal,
        },
        Value::Number(value) => MetadataValue {
            source: source.into(),
            key: key.into(),
            value_type: "number".into(),
            text_value: None,
            number_value: value.as_f64(),
            date_value: None,
            boolean_value: None,
            sensitive,
            ordinal,
        },
        Value::String(value) => MetadataValue {
            source: source.into(),
            key: key.into(),
            value_type: "text".into(),
            text_value: Some(value),
            number_value: None,
            date_value: None,
            boolean_value: None,
            sensitive,
            ordinal,
        },
        _ => unreachable!(),
    }
}

fn capture_time(
    groups: &BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    mtime_ns: i64,
) -> (Option<String>, Option<String>, Option<i32>, String) {
    for (source, keys) in [
        (
            "sidecar_xmp",
            &[
                "sidecar_xmp:XMP:DateTimeOriginal",
                "sidecar_xmp:XMP:CreateDate",
            ][..],
        ),
        (
            "embedded_xmp",
            &["XMP:DateTimeOriginal", "XMP:CreateDate"][..],
        ),
        ("iptc", &["IPTC:DateCreated"][..]),
        (
            "exif",
            &[
                "EXIF:DateTimeOriginal",
                "EXIF:CreateDate",
                "IFD0:ModifyDate",
            ][..],
        ),
        ("video", &["video:format.tags.creation_time"][..]),
    ] {
        if let Some(raw) = metadata_string(groups, keys)
            && let Some((utc, local, offset)) = parse_capture_date(&raw)
        {
            return (utc, Some(local), offset, source.into());
        }
    }
    let fallback = iso_from_ns(mtime_ns);
    (
        Some(fallback.clone()),
        Some(fallback.trim_end_matches('Z').into()),
        Some(0),
        "file_mtime".into(),
    )
}

fn parse_capture_date(value: &str) -> Option<(Option<String>, String, Option<i32>)> {
    let trimmed = value.trim();
    if let Ok(date) = OffsetDateTime::parse(trimmed, &Rfc3339) {
        let local = trimmed.get(..19)?.replace(' ', "T");
        let offset = date.offset().whole_minutes() as i32;
        return Some((date.format(&Rfc3339).ok(), local, Some(offset)));
    }
    let normalized = trimmed.replace(' ', "T");
    let mut chars: Vec<char> = normalized.chars().collect();
    if chars.get(4) == Some(&':') && chars.get(7) == Some(&':') {
        chars[4] = '-';
        chars[7] = '-';
    }
    let local: String = chars.into_iter().take(19).collect();
    if local.len() == 19 {
        Some((None, local, None))
    } else {
        None
    }
}

fn dimensions(
    groups: &BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    probe: Option<&Value>,
) -> Result<(u32, u32), PhotostaffError> {
    if let Some(streams) = probe
        .and_then(|value| value.get("streams"))
        .and_then(Value::as_array)
        && let Some(stream) = streams
            .iter()
            .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        && let (Some(width), Some(height)) = (
            stream.get("width").and_then(Value::as_u64),
            stream.get("height").and_then(Value::as_u64),
        )
    {
        return Ok((width as u32, height as u32));
    }
    let width = metadata_number(
        groups,
        &["EXIF:ExifImageWidth", "File:ImageWidth", "PNG:ImageWidth"],
    );
    let height = metadata_number(
        groups,
        &[
            "EXIF:ExifImageHeight",
            "File:ImageHeight",
            "PNG:ImageHeight",
        ],
    );
    match (width, height) {
        (Some(width), Some(height)) if width > 0.0 && height > 0.0 => {
            Ok((width as u32, height as u32))
        }
        _ => Err(PhotostaffError::new(
            ErrorCode::CorruptMedia,
            "Media dimensions are unavailable",
            false,
        )),
    }
}

fn metadata_strings(
    groups: &BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    keys: &[&str],
) -> Vec<String> {
    for key in keys {
        let Some((source, field)) = key.split_once(':') else {
            continue;
        };
        if let Some(found) = groups
            .get(&source.to_ascii_lowercase())
            .and_then(|group| group.get(field))
        {
            let values: Vec<_> = found
                .iter()
                .filter_map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                })
                .collect();
            if !values.is_empty() {
                return values;
            }
        }
    }
    Vec::new()
}

fn metadata_string(
    groups: &BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    keys: &[&str],
) -> Option<String> {
    metadata_strings(groups, keys)
        .into_iter()
        .next()
        .or_else(|| {
            keys.iter().find_map(|key| {
                let (source, field) = key.split_once(':')?;
                groups
                    .get(&source.to_ascii_lowercase())?
                    .get(field)?
                    .iter()
                    .find_map(|value| value.as_f64().map(|value| value.to_string()))
            })
        })
}

fn metadata_number(
    groups: &BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter().find_map(|key| {
        let (source, field) = key.split_once(':')?;
        groups
            .get(&source.to_ascii_lowercase())?
            .get(field)?
            .iter()
            .find_map(number_value)
    })
}

fn number_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.split_whitespace().next()?.parse().ok())
}

fn json_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key)?.as_str().map(str::to_owned))
}

fn bounded(value: Option<f64>, minimum: f64, maximum: f64) -> Option<f64> {
    value.filter(|value| *value >= minimum && *value <= maximum)
}

fn omitted_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "makernote",
        "thumbnail",
        "preview",
        "imagesourcedata",
        "stripoffsets",
        "stripbytecounts",
        "jpeginterchangeformat",
    ]
    .iter()
    .any(|part| lower.contains(part))
}

fn sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "gps",
        "latitude",
        "longitude",
        "location",
        "serial",
        "owner",
        "contact",
        "person",
        "people",
        "face",
        "region",
    ]
    .iter()
    .any(|part| lower.contains(part))
}

fn mime_for_name(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn is_heif(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("heic" | "heif")
    )
}

fn iso_from_ns(timestamp_ns: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp_ns))
        .ok()
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions_and_derivative_keys() {
        assert_eq!(candidate_kind("a.JPG"), Some(MediaKind::Image));
        assert_eq!(candidate_kind("a.CR3"), Some(MediaKind::Raw));
        assert_eq!(candidate_kind("a.mp4"), Some(MediaKind::Video));
        assert!(candidate_kind("a.txt").is_none());
        assert_ne!(
            derivative_key("hash", "thumbnail", "a"),
            derivative_key("hash", "thumbnail", "b")
        );
    }

    #[test]
    fn rejects_pixel_bombs_before_derivative_generation() {
        assert_eq!(
            validate_pixel_limit(20_000, 20_000, 268_402_689)
                .unwrap_err()
                .code,
            ErrorCode::SizeLimit
        );
        assert!(validate_pixel_limit(512, 512, 268_402_689).is_ok());
    }

    #[test]
    fn preserves_all_gif_frames_for_derivatives() {
        assert_eq!(
            derivative_input(None, "image/gif"),
            PathBuf::from(format!("{}[n=-1]", child_media_path()))
        );
        assert_eq!(
            derivative_input(None, "image/jpeg"),
            PathBuf::from(child_media_path())
        );
    }

    #[test]
    fn marks_case_colliding_sidecars_ambiguous() {
        let result =
            sidecar_associations(&["a.jpg".into(), "A.JPG.XMP".into(), "a.jpg.xmp".into()]);
        assert!(result["a.jpg"].is_err());
    }

    #[test]
    fn sanitizes_metadata_with_limits_and_sensitive_flags() {
        let mut groups = BTreeMap::new();
        let mut values = Vec::new();
        let mut warnings = Vec::new();
        sanitize_object(
            &serde_json::json!({"EXIF:ISO": 800, "EXIF:GPSLatitude": 1.0}),
            None,
            &mut groups,
            &mut values,
            &mut warnings,
        );
        assert_eq!(metadata_number(&groups, &["EXIF:ISO"]), Some(800.0));
        assert!(
            values
                .iter()
                .any(|value| value.key.contains("GPS") && value.sensitive)
        );
    }

    #[test]
    fn temporary_files_remove_unkept_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let removed = directory.path().join("removed.tmp");
        let kept = directory.path().join("kept.tmp");
        std::fs::write(&removed, b"remove").unwrap();
        std::fs::write(&kept, b"keep").unwrap();
        {
            let mut files = TemporaryFiles::default();
            files.track(&removed);
            files.track(&kept);
            files.keep(&kept);
        }
        assert!(!removed.exists());
        assert!(kept.exists());
    }
}
