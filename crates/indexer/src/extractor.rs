use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::Event;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

use crate::db::IndexerSettings;
use crate::error::{ErrorCode, IndexerError};

const MAX_ZIP_ENTRIES: usize = 20_000;
const MAX_XML_CELLS: usize = 1_000_000;
const MIN_SELECTED_XML_ENTRY_BYTES: u64 = 1024 * 1024;
const MAX_SELECTED_XML_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MIN_PDF_TEXT_CHARACTERS: usize = 32;
pub const OCR_LANGUAGES: &str = "chi_sim+eng";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractionSource {
    PlainText,
    PdfText,
    Docx,
    Xlsx,
    Pptx,
    Ocr,
}

impl ExtractionSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PlainText => "plain_text",
            Self::PdfText => "pdftotext",
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Ocr => "ocr",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExtractedFile {
    pub hash: String,
    pub mime_type: String,
    pub body: String,
    pub terms: String,
    pub source: Option<ExtractionSource>,
    pub status: &'static str,
}

pub async fn extract_file(
    mut file: File,
    name: &str,
    settings: &IndexerSettings,
    ocr_enabled: bool,
) -> Result<ExtractedFile, IndexerError> {
    let size = file.metadata().map_err(IndexerError::storage)?.len();
    let mut hash_input = file.try_clone().map_err(IndexerError::storage)?;
    let hash = tokio::task::spawn_blocking(move || hash_file(&mut hash_input))
        .await
        .map_err(|error| IndexerError::internal(error.to_string()))??;
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = mime_type_for_extension(&extension).to_owned();
    file.seek(SeekFrom::Start(0))
        .map_err(IndexerError::storage)?;

    let (body, source, status) = if is_plain_text(&extension) {
        let limit = settings.max_extracted_text_bytes;
        (
            tokio::task::spawn_blocking(move || read_text_limited(&mut file, limit))
                .await
                .map_err(|error| IndexerError::internal(error.to_string()))??,
            Some(ExtractionSource::PlainText),
            "ready",
        )
    } else if extension == "pdf" {
        ensure_document_size(size, settings.max_source_document_bytes)?;
        let text = run_command_with_input(
            "pdftotext",
            &[
                "-f".to_owned(),
                "1".to_owned(),
                "-l".to_owned(),
                settings.max_pdf_text_pages.to_string(),
                "-".to_owned(),
                "-".to_owned(),
            ],
            file.try_clone().map_err(IndexerError::storage)?,
            settings.command_timeout(),
            settings.max_extracted_text_bytes,
        )
        .await?;
        if visible_characters(&text) < MIN_PDF_TEXT_CHARACTERS && ocr_enabled {
            file.seek(SeekFrom::Start(0))
                .map_err(IndexerError::storage)?;
            (
                extract_pdf_ocr(file.try_clone().map_err(IndexerError::storage)?, settings).await?,
                Some(ExtractionSource::Ocr),
                "ready",
            )
        } else {
            (text, Some(ExtractionSource::PdfText), "ready")
        }
    } else if matches!(extension.as_str(), "docx" | "xlsx" | "pptx") {
        ensure_document_size(size, settings.max_source_document_bytes)?;
        let source = match extension.as_str() {
            "docx" => ExtractionSource::Docx,
            "xlsx" => ExtractionSource::Xlsx,
            _ => ExtractionSource::Pptx,
        };
        let source_limit = settings.max_source_document_bytes;
        let output_limit = settings.max_extracted_text_bytes;
        (
            tokio::task::spawn_blocking(move || {
                extract_ooxml(file, &extension, source_limit, output_limit)
            })
            .await
            .map_err(|error| IndexerError::internal(error.to_string()))??,
            Some(source),
            "ready",
        )
    } else {
        (String::new(), None, "skipped")
    };
    let terms = normalized_terms(&body, settings.max_extracted_text_bytes);
    Ok(ExtractedFile {
        hash,
        mime_type,
        body,
        terms,
        source,
        status,
    })
}

fn hash_file(file: &mut File) -> Result<String, IndexerError> {
    file.seek(SeekFrom::Start(0))
        .map_err(IndexerError::storage)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(IndexerError::storage)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn read_text_limited(file: &mut File, limit: usize) -> Result<String, IndexerError> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(IndexerError::storage)?;
    if bytes.len() > limit {
        bytes.truncate(limit);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn ensure_document_size(size: u64, limit: u64) -> Result<(), IndexerError> {
    if size > limit {
        return Err(IndexerError::new(
            ErrorCode::SizeLimit,
            format!("Document exceeds the configured source limit of {limit} bytes"),
            false,
        ));
    }
    Ok(())
}

async fn run_command_with_input(
    program: &str,
    arguments: &[String],
    input: File,
    timeout: Duration,
    output_limit: usize,
) -> Result<String, IndexerError> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::from(input))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            IndexerError::new(
                ErrorCode::ToolUnavailable,
                format!("Required extractor is unavailable: {program}"),
                true,
            )
        } else {
            IndexerError::storage(error)
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| IndexerError::internal("Extractor stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| IndexerError::internal("Extractor stderr unavailable"))?;
    let stdout_task = tokio::spawn(read_async_limited(stdout, output_limit));
    let stderr_task = tokio::spawn(read_async_limited(stderr, 64 * 1024));
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(IndexerError::storage)?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(IndexerError::new(
                ErrorCode::CommandTimeout,
                format!("{program} exceeded the configured timeout"),
                true,
            ));
        }
    };
    let output = stdout_task
        .await
        .map_err(|error| IndexerError::internal(error.to_string()))??;
    let error = stderr_task
        .await
        .map_err(|error| IndexerError::internal(error.to_string()))??;
    if output.overflow {
        return Err(IndexerError::new(
            ErrorCode::SizeLimit,
            format!("{program} output exceeded the configured text limit"),
            false,
        ));
    }
    if !status.success() {
        return Err(IndexerError::new(
            ErrorCode::CommandFailed,
            format!(
                "{program} failed: {}",
                String::from_utf8_lossy(&error.bytes)
            ),
            false,
        ));
    }
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}

struct LimitedOutput {
    bytes: Vec<u8>,
    overflow: bool,
}

async fn read_async_limited<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<LimitedOutput, IndexerError> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut overflow = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(IndexerError::storage)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = read.min(remaining);
        bytes.extend_from_slice(&buffer[..retained]);
        overflow |= retained < read;
    }
    Ok(LimitedOutput { bytes, overflow })
}

async fn extract_pdf_ocr(file: File, settings: &IndexerSettings) -> Result<String, IndexerError> {
    let directory = tempfile::tempdir().map_err(IndexerError::storage)?;
    let prefix = directory.path().join("page");
    let arguments = vec![
        "-f".to_owned(),
        "1".to_owned(),
        "-l".to_owned(),
        settings.max_ocr_pages.to_string(),
        "-r".to_owned(),
        "150".to_owned(),
        "-scale-to".to_owned(),
        "4096".to_owned(),
        "-png".to_owned(),
        "-".to_owned(),
        prefix.to_string_lossy().into_owned(),
    ];
    run_command_without_output("pdftoppm", &arguments, file, settings.command_timeout()).await?;
    let mut images: Vec<_> = std::fs::read_dir(directory.path())
        .map_err(IndexerError::storage)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|value| value == "png"))
        .collect();
    images.sort();
    let mut text = String::new();
    for image in images.into_iter().take(settings.max_ocr_pages) {
        let input = File::open(&image).map_err(IndexerError::storage)?;
        if !text.is_empty() {
            if text.len() >= settings.max_extracted_text_bytes {
                break;
            }
            text.push('\n');
        }
        let remaining = settings.max_extracted_text_bytes.saturating_sub(text.len());
        if remaining == 0 {
            break;
        }
        let page = run_command_with_input(
            "tesseract",
            &[
                "stdin".to_owned(),
                "stdout".to_owned(),
                "-l".to_owned(),
                OCR_LANGUAGES.to_owned(),
            ],
            input,
            settings.command_timeout(),
            remaining,
        )
        .await?;
        text.push_str(&page);
    }
    Ok(text)
}

async fn run_command_without_output(
    program: &str,
    arguments: &[String],
    input: File,
    timeout: Duration,
) -> Result<(), IndexerError> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::from(input))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                IndexerError::new(
                    ErrorCode::ToolUnavailable,
                    format!("Required extractor is unavailable: {program}"),
                    true,
                )
            } else {
                IndexerError::storage(error)
            }
        })?;
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(IndexerError::storage)?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(IndexerError::new(
                ErrorCode::CommandTimeout,
                format!("{program} exceeded the configured timeout"),
                true,
            ));
        }
    };
    if status.success() {
        Ok(())
    } else {
        Err(IndexerError::new(
            ErrorCode::CommandFailed,
            format!("{program} failed"),
            false,
        ))
    }
}

fn extract_ooxml(
    file: File,
    extension: &str,
    source_limit: u64,
    output_limit: usize,
) -> Result<String, IndexerError> {
    let mut archive = ZipArchive::new(file).map_err(|error| {
        IndexerError::new(
            ErrorCode::CorruptDocument,
            format!("Invalid OOXML archive: {error}"),
            false,
        )
    })?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(IndexerError::new(
            ErrorCode::SizeLimit,
            "OOXML archive has too many entries",
            false,
        ));
    }
    let expanded_limit = source_limit.saturating_mul(4).min(2 * 1024 * 1024 * 1024);
    let selected_entry_limit = (output_limit as u64)
        .saturating_mul(8)
        .clamp(MIN_SELECTED_XML_ENTRY_BYTES, MAX_SELECTED_XML_ENTRY_BYTES);
    let mut expanded = 0_u64;
    let mut selected = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            IndexerError::new(ErrorCode::CorruptDocument, error.to_string(), false)
        })?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > expanded_limit {
            return Err(IndexerError::new(
                ErrorCode::SizeLimit,
                "OOXML expanded data exceeds the safety limit",
                false,
            ));
        }
        let name = entry.name().to_owned();
        let include = match extension {
            "docx" => {
                name == "word/document.xml"
                    || name.starts_with("word/header")
                    || name.starts_with("word/footer")
            }
            "xlsx" => name == "xl/sharedStrings.xml" || name.starts_with("xl/worksheets/sheet"),
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            _ => false,
        };
        if include {
            if entry.size() > selected_entry_limit {
                return Err(IndexerError::new(
                    ErrorCode::SizeLimit,
                    "OOXML XML entry exceeds the safety limit",
                    false,
                ));
            }
            selected.push((index, name));
        }
    }
    selected.sort_by(|left, right| left.1.cmp(&right.1));
    let mut output = String::new();
    let mut cells = 0_usize;
    for (index, _) in selected {
        let entry = archive.by_index(index).map_err(|error| {
            IndexerError::new(ErrorCode::CorruptDocument, error.to_string(), false)
        })?;
        let mut bounded_entry = entry.take(selected_entry_limit + 1);
        extract_xml_text(&mut bounded_entry, &mut output, output_limit, &mut cells)?;
        if output.len() >= output_limit {
            break;
        }
    }
    Ok(output)
}

fn extract_xml_text(
    input: &mut impl Read,
    output: &mut String,
    output_limit: usize,
    cells: &mut usize,
) -> Result<(), IndexerError> {
    let mut reader = Reader::from_reader(BufReader::new(input));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(start)) if start.name().as_ref() == b"c" => {
                *cells += 1;
                if *cells > MAX_XML_CELLS {
                    return Err(IndexerError::new(
                        ErrorCode::SizeLimit,
                        "OOXML cell count exceeds the safety limit",
                        false,
                    ));
                }
            }
            Ok(Event::Text(text)) => {
                let decoded = text.decode().map_err(|error| {
                    IndexerError::new(ErrorCode::CorruptDocument, error.to_string(), false)
                })?;
                let unescaped = quick_xml::escape::unescape(&decoded).map_err(|error| {
                    IndexerError::new(ErrorCode::CorruptDocument, error.to_string(), false)
                })?;
                append_limited(output, &unescaped, output_limit);
                if output.len() >= output_limit {
                    return Ok(());
                }
            }
            Ok(Event::Eof) => return Ok(()),
            Ok(_) => {}
            Err(error) => {
                return Err(IndexerError::new(
                    ErrorCode::CorruptDocument,
                    error.to_string(),
                    false,
                ));
            }
        }
        buffer.clear();
    }
}

fn append_limited(output: &mut String, text: &str, limit: usize) {
    if text.trim().is_empty() || output.len() >= limit {
        return;
    }
    if !output.is_empty() {
        output.push(' ');
    }
    for character in text.chars() {
        if output.len() + character.len_utf8() > limit {
            break;
        }
        output.push(character);
    }
}

pub fn normalized_terms(body: &str, limit: usize) -> String {
    let normalized: String = body.nfkc().flat_map(char::to_lowercase).collect();
    let mut terms = String::with_capacity(normalized.len().min(limit));
    for token in normalized.split_whitespace() {
        push_term(&mut terms, token, limit);
        let cjk: Vec<char> = token
            .chars()
            .filter(|character| is_cjk(*character))
            .collect();
        for (index, character) in cjk.iter().enumerate() {
            push_term(&mut terms, &character.to_string(), limit);
            if let Some(next) = cjk.get(index + 1) {
                push_term(&mut terms, &format!("{character}{next}"), limit);
            }
        }
        if terms.len() >= limit {
            break;
        }
    }
    terms
}

fn push_term(output: &mut String, term: &str, limit: usize) {
    if term.is_empty() || output.len() >= limit {
        return;
    }
    let separator = usize::from(!output.is_empty());
    if output.len() + separator + term.len() > limit {
        return;
    }
    if separator == 1 {
        output.push(' ');
    }
    output.push_str(term);
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x30FF | 0xAC00..=0xD7AF)
}

fn visible_characters(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

fn is_plain_text(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "markdown"
            | "json"
            | "jsonl"
            | "toml"
            | "yaml"
            | "yml"
            | "xml"
            | "csv"
            | "tsv"
            | "log"
            | "ini"
            | "conf"
            | "cfg"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "css"
            | "html"
            | "htm"
            | "py"
            | "rb"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "sql"
    )
}

pub fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "txt" | "md" | "markdown" | "log" | "ini" | "conf" | "cfg" => "text/plain",
        "json" | "jsonl" => "application/json",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ if is_plain_text(extension) => "text/plain",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_nfkc_and_cjk_search_terms() {
        let terms = normalized_terms("ＡＬＰＨＡ 项目计划", 1024);
        assert!(terms.contains("alpha"));
        assert!(terms.contains("项目"));
        assert!(terms.contains("计划"));
    }

    #[test]
    fn rejects_zip_bomb_metadata_before_expansion() {
        assert!(ensure_document_size(11, 10).is_err());
    }

    #[tokio::test]
    async fn drains_extractor_output_after_the_retained_limit() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(8);
        let write = tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 1024]).await.unwrap();
        });
        let output = read_async_limited(reader, 16).await.unwrap();
        write.await.unwrap();
        assert_eq!(output.bytes.len(), 16);
        assert!(output.overflow);
    }
}
