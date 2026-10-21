use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdPowerRequest"))]
#[serde(deny_unknown_fields)]
pub(crate) struct PowerRequest {
    action: PowerAction,
    confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdPowerAction"))]
#[serde(rename_all = "snake_case")]
pub(crate) enum PowerAction {
    Reboot,
    Shutdown,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdPowerResult"))]
pub(crate) struct PowerResult {
    action: PowerAction,
    #[cfg_attr(test, ts(type = "true"))]
    accepted: bool,
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    PowerRequest::export_all(config).unwrap();
    PowerResult::export_all(config).unwrap();
}

pub(crate) async fn command(
    request: PowerRequest,
    runner: &dyn CommandRunner,
) -> Result<PowerResult, HostdError> {
    if !request.confirmed {
        return Err(HostdError::validation(
            "Power action confirmation is required",
        ));
    }

    let (command, action) = match request.action {
        PowerAction::Reboot => ("reboot", PowerAction::Reboot),
        PowerAction::Shutdown => ("poweroff", PowerAction::Shutdown),
    };
    run_checked(runner, "systemctl", &["--no-block", command], None).await?;
    Ok(PowerResult {
        action,
        accepted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;
    use std::time::Duration;

    async fn command_payload(
        payload: Value,
        runner: &dyn CommandRunner,
    ) -> Result<Value, HostdError> {
        let request: PowerRequest = serde_json::from_value(payload)
            .map_err(|_| HostdError::validation("A confirmed power action is required"))?;
        serde_json::to_value(command(request, runner).await?)
            .map_err(|error| HostdError::operation_failed(error.to_string()))
    }

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        success: bool,
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            _input: Option<&[u8]>,
            _command_timeout: Duration,
            _output_limit: usize,
        ) -> Result<crate::command::CommandOutput, HostdError> {
            self.calls
                .lock()
                .unwrap()
                .push((command.to_owned(), args.to_vec()));
            Ok(crate::command::CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                success: self.success,
            })
        }
    }

    #[tokio::test]
    async fn maps_reboot_to_fixed_systemctl_command() {
        let runner = FakeRunner {
            success: true,
            ..Default::default()
        };
        let result = command_payload(json!({ "action": "reboot", "confirmed": true }), &runner)
            .await
            .unwrap();
        assert_eq!(result, json!({ "action": "reboot", "accepted": true }));
        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[(
                "systemctl".to_owned(),
                vec!["--no-block".to_owned(), "reboot".to_owned()]
            )]
        );
    }

    #[tokio::test]
    async fn maps_shutdown_to_poweroff_without_accepting_extra_arguments() {
        let runner = FakeRunner {
            success: true,
            ..Default::default()
        };
        let result = command_payload(json!({ "action": "shutdown", "confirmed": true }), &runner)
            .await
            .unwrap();
        assert_eq!(result, json!({ "action": "shutdown", "accepted": true }));
        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[(
                "systemctl".to_owned(),
                vec!["--no-block".to_owned(), "poweroff".to_owned()]
            )]
        );
    }

    #[tokio::test]
    async fn rejects_unconfirmed_unknown_and_extra_fields() {
        let runner = FakeRunner {
            success: true,
            ..Default::default()
        };
        for payload in [
            json!({ "action": "reboot", "confirmed": false }),
            json!({ "action": "hibernate", "confirmed": true }),
            json!({ "action": "reboot", "confirmed": true, "command": "rm -rf /" }),
        ] {
            assert!(command_payload(payload, &runner).await.is_err());
        }
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}
