use std::io::Write;

use cyberos_indexer::db::IndexerSettings;
use cyberos_indexer::extractor::{ExtractionSource, extract_file};
use zip::write::SimpleFileOptions;

#[tokio::test]
async fn extracts_plain_text_with_a_bounded_body() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("notes.txt");
    std::fs::write(&path, "alpha 项目计划").unwrap();
    let result = extract_file(
        std::fs::File::open(path).unwrap(),
        "notes.txt",
        &IndexerSettings::default(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(result.source, Some(ExtractionSource::PlainText));
    assert!(result.body.contains("alpha"));
    assert!(result.terms.contains("项目"));
}

#[tokio::test]
async fn extracts_docx_xml_and_rejects_corrupt_archives() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.docx");
    {
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(br#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>alpha document</w:t></w:r></w:p></w:body></w:document>"#).unwrap();
        archive.finish().unwrap();
    }
    let extracted = extract_file(
        std::fs::File::open(&path).unwrap(),
        "document.docx",
        &IndexerSettings::default(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(extracted.source, Some(ExtractionSource::Docx));
    assert!(extracted.body.contains("alpha document"));

    let corrupt = directory.path().join("corrupt.docx");
    std::fs::write(&corrupt, "not a zip").unwrap();
    assert!(
        extract_file(
            std::fs::File::open(corrupt).unwrap(),
            "corrupt.docx",
            &IndexerSettings::default(),
            false,
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn rejects_a_single_oversized_ooxml_xml_entry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("oversized.docx");
    {
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"<w:t>").unwrap();
        archive.write_all(&vec![b'a'; 1024 * 1024 + 1]).unwrap();
        archive.write_all(b"</w:t>").unwrap();
        archive.finish().unwrap();
    }
    let settings = IndexerSettings {
        max_extracted_text_bytes: 16,
        ..IndexerSettings::default()
    };
    let error = extract_file(
        std::fs::File::open(path).unwrap(),
        "oversized.docx",
        &settings,
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code.as_str(), "SIZE_LIMIT");
}
