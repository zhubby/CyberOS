use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::model::RollbackStatus;
use super::validation::is_uuid;

pub(super) async fn active_connection_uuid(
    device: &str,
    runner: &dyn CommandRunner,
) -> Result<Option<String>, HostdError> {
    let value = run_checked(
        runner,
        "nmcli",
        &["--get-values", "GENERAL.CON-UUID", "device", "show", device],
        None,
    )
    .await?;
    let value = value.trim();
    Ok(is_uuid(value).then(|| value.to_owned()))
}

pub(super) async fn assert_wifi_device(
    device: &str,
    runner: &dyn CommandRunner,
) -> Result<(), HostdError> {
    let args = [
        "--get-values".to_owned(),
        "GENERAL.TYPE".to_owned(),
        "device".to_owned(),
        "show".to_owned(),
        device.to_owned(),
    ];
    let output = runner
        .run(
            "nmcli",
            &args,
            None,
            crate::command::DEFAULT_COMMAND_TIMEOUT,
            crate::command::DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if !output.success {
        return Err(HostdError::not_found("Wireless device not found"));
    }
    if !matches!(output.stdout.trim(), "wifi" | "802-11-wireless") {
        return Err(HostdError::validation(
            "Only wireless devices can be managed",
        ));
    }
    Ok(())
}

pub(super) async fn assert_client_profile(
    id: &str,
    runner: &dyn CommandRunner,
) -> Result<(), HostdError> {
    let output = run_checked(
        runner,
        "nmcli",
        &[
            "--get-values",
            "connection.type,802-11-wireless.mode",
            "connection",
            "show",
            "uuid",
            id,
        ],
        None,
    )
    .await
    .map_err(|_| HostdError::not_found("Wi-Fi profile not found"))?;
    let mut lines = output.lines().map(str::trim);
    let connection_type = lines.next().unwrap_or_default();
    let mode = lines.next().unwrap_or_default();
    if !matches!(connection_type, "wifi" | "802-11-wireless") || mode == "ap" {
        return Err(HostdError::validation(
            "Only client Wi-Fi profiles can be activated",
        ));
    }
    Ok(())
}

pub(super) async fn is_connection_active(id: &str, runner: &dyn CommandRunner) -> bool {
    run_checked(
        runner,
        "nmcli",
        &[
            "--terse",
            "--fields",
            "UUID",
            "connection",
            "show",
            "--active",
        ],
        None,
    )
    .await
    .is_ok_and(|output| output.lines().any(|line| line.trim() == id))
}

pub(super) async fn restore_connection(
    id: Option<&str>,
    device: &str,
    runner: &dyn CommandRunner,
) -> RollbackStatus {
    let Some(id) = id else {
        return RollbackStatus::NotRequired;
    };
    if run_checked(
        runner,
        "nmcli",
        &["connection", "up", "uuid", id, "ifname", device],
        None,
    )
    .await
    .is_ok()
    {
        RollbackStatus::Succeeded
    } else {
        RollbackStatus::Failed
    }
}

pub(super) async fn assert_available(runner: &dyn CommandRunner) -> Result<(), HostdError> {
    let running = run_checked(
        runner,
        "nmcli",
        &["--terse", "--fields", "RUNNING", "general"],
        None,
    )
    .await
    .map_err(|_| HostdError::unavailable("NetworkManager is unavailable"))?;
    if running.to_ascii_lowercase().contains("running") {
        Ok(())
    } else {
        Err(HostdError::unavailable("NetworkManager is unavailable"))
    }
}

pub(super) async fn safe_reload(runner: &dyn CommandRunner) {
    let _ = run_checked(runner, "nmcli", &["connection", "reload"], None).await;
}

pub(super) fn split_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == ':' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    fields.push(current);
    fields
}

pub(super) fn security(value: &str) -> &'static str {
    let normalized = value.to_ascii_uppercase();
    if normalized.is_empty() || normalized == "--" {
        "open"
    } else if normalized.contains("WEP") || normalized.contains("802.1X") {
        "unsupported"
    } else if normalized.contains("SAE") && !normalized.contains("WPA2") {
        "wpa3"
    } else if normalized.contains("WPA") {
        "wpa2"
    } else {
        "unsupported"
    }
}

pub(super) fn parse_integer(value: &str) -> Option<i32> {
    value.trim().parse().ok()
}

pub(super) fn parse_frequency(value: &str) -> Option<u32> {
    value
        .trim()
        .strip_suffix("MHz")
        .unwrap_or(value.trim())
        .trim()
        .parse()
        .ok()
}

pub(super) async fn run_owned(
    runner: &dyn CommandRunner,
    args: &[String],
) -> Result<String, HostdError> {
    let output = runner
        .run(
            "nmcli",
            args,
            None,
            crate::command::DEFAULT_COMMAND_TIMEOUT,
            crate::command::DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(HostdError::operation_failed(
            if output.stderr.trim().is_empty() {
                "NetworkManager operation failed".to_owned()
            } else {
                output.stderr
            },
        ))
    }
}
