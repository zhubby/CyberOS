use cyberos_indexer::extractor::OCR_LANGUAGES;

#[test]
fn ocr_language_set_is_fixed_to_chinese_and_english() {
    assert_eq!(OCR_LANGUAGES, "chi_sim+eng");
}
