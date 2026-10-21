use std::time::{Duration, SystemTime};

use rand::Rng;

pub fn retry_delay(
    retry_count: u32,
    base_ms: u64,
    maximum_ms: u64,
    retry_after_ms: Option<u64>,
    retry_after_cap_ms: u64,
) -> Duration {
    if let Some(delay) = retry_after_ms {
        return Duration::from_millis(delay.min(retry_after_cap_ms));
    }
    let exponent = retry_count.saturating_sub(1).min(30);
    let delay = base_ms.saturating_mul(1_u64 << exponent).min(maximum_ms);
    let jitter = rand::rng().random_range(0..=delay.saturating_div(4));
    Duration::from_millis(delay.saturating_add(jitter).min(maximum_ms))
}

pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<u64> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(seconds.saturating_mul(1_000));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(
        at.duration_since(now)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_retry_after_and_caps_it() {
        assert_eq!(
            retry_delay(1, 2_000, 300_000, Some(1_000_000), 900_000),
            Duration::from_millis(900_000)
        );
        assert_eq!(
            parse_retry_after("10", SystemTime::UNIX_EPOCH),
            Some(10_000)
        );
    }

    #[test]
    fn exponential_delay_stays_within_the_configured_ceiling() {
        for _ in 0..100 {
            let first = retry_delay(1, 2_000, 300_000, None, 900_000);
            assert!((Duration::from_millis(2_000)..=Duration::from_millis(2_500)).contains(&first));
            assert!(
                retry_delay(10, 2_000, 300_000, None, 900_000) <= Duration::from_millis(300_000)
            );
        }
    }
}
