use std::time::Duration;

use rand::Rng;

use crate::db::ProcessingSettings;
use crate::error::{ErrorCode, PhotostaffError};

pub fn retry_delay(
    error: &PhotostaffError,
    retry_count: u32,
    settings: &ProcessingSettings,
) -> Option<Duration> {
    let storage = error.code == ErrorCode::PhotostaffStorageUnavailable;
    if !error.retryable || (!storage && retry_count >= settings.max_auto_retries) {
        return None;
    }
    let exponent = retry_count.min(31);
    let raw = settings
        .retry_base_delay_ms
        .saturating_mul(1_u64 << exponent);
    let capped = raw.min(settings.retry_max_delay_ms);
    let floor = capped.saturating_mul(3) / 4;
    let delay = rand::rng().random_range(floor..=capped.max(floor));
    Some(Duration::from_millis(delay))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_backoff_and_retries_storage_indefinitely() {
        let settings = ProcessingSettings::default();
        let command = PhotostaffError::new(ErrorCode::CommandTimeout, "timeout", true);
        assert!(retry_delay(&command, settings.max_auto_retries, &settings).is_none());
        let storage =
            PhotostaffError::new(ErrorCode::PhotostaffStorageUnavailable, "offline", true);
        assert!(
            retry_delay(&storage, 100, &settings).unwrap()
                <= Duration::from_millis(settings.retry_max_delay_ms)
        );
    }
}
