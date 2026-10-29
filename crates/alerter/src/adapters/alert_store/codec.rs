use crate::domain::rule::{
    Aggregation, Comparator, InstanceState, MetricTransform, NoDataPolicy, Severity,
};

const RETRY_DELAYS_SECONDS: &[i64] = &[60, 300, 900, 3_600, 14_400, 43_200, 86_400];

pub(super) fn iso(timestamp_ms: i64) -> String {
    let seconds = timestamp_ms.div_euclid(1_000);
    let milliseconds = timestamp_ms.rem_euclid(1_000);
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|value| value.replace_millisecond(milliseconds as u16).ok())
        .and_then(|value| {
            value
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

pub(super) fn parse_iso(value: &str) -> i64 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
        .unwrap_or_default()
}

pub(super) fn sanitize_error(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.to_ascii_lowercase().contains("password") {
        return "Alert operation failed".to_owned();
    }
    normalized.chars().take(240).collect()
}

pub(super) fn retry_delay(attempt: i64) -> i64 {
    let index = usize::try_from(attempt.saturating_sub(1)).unwrap_or_default();
    *RETRY_DELAYS_SECONDS
        .get(index)
        .unwrap_or(RETRY_DELAYS_SECONDS.last().expect("retry delays"))
}

pub(super) fn parse_transform(value: &str) -> MetricTransform {
    if value == "rate" {
        MetricTransform::Rate
    } else {
        MetricTransform::Value
    }
}

pub(super) fn parse_aggregation(value: &str) -> Aggregation {
    match value {
        "avg" => Aggregation::Avg,
        "min" => Aggregation::Min,
        "max" => Aggregation::Max,
        _ => Aggregation::Last,
    }
}

pub(super) fn parse_comparator(value: &str) -> Comparator {
    match value {
        ">=" => Comparator::GreaterOrEqual,
        "<" => Comparator::Less,
        "<=" => Comparator::LessOrEqual,
        _ => Comparator::Greater,
    }
}

pub(super) fn parse_severity(value: &str) -> Severity {
    if value == "critical" {
        Severity::Critical
    } else {
        Severity::Warning
    }
}

pub(super) fn parse_no_data(value: &str) -> NoDataPolicy {
    if value == "firing" {
        NoDataPolicy::Firing
    } else {
        NoDataPolicy::Ignore
    }
}

pub(super) fn parse_instance_state(value: &str) -> InstanceState {
    match value {
        "pending" => InstanceState::Pending,
        "firing" => InstanceState::Firing,
        "recovering" => InstanceState::Recovering,
        "resolved" => InstanceState::Resolved,
        _ => InstanceState::Normal,
    }
}

pub(super) fn instance_state(value: InstanceState) -> &'static str {
    match value {
        InstanceState::Normal => "normal",
        InstanceState::Pending => "pending",
        InstanceState::Firing => "firing",
        InstanceState::Recovering => "recovering",
        InstanceState::Resolved => "resolved",
    }
}

pub(super) fn severity(value: Severity) -> &'static str {
    match value {
        Severity::Warning => "warning",
        Severity::Critical => "critical",
    }
}
