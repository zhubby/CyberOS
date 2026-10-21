use std::time::{SystemTime, UNIX_EPOCH};

use crate::ports::Clock;

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn wall_time_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| i64::try_from(value.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or_default()
    }
}
