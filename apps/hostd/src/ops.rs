use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdOpsRequest"))]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsRequest {
    task: OpsTask,
    confirmed: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdOpsTask"))]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsTask {
    Health,
    Maintenance,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdOpsResult"))]
pub(crate) struct OpsResult {
    task: OpsTask,
    #[cfg_attr(test, ts(type = "true"))]
    accepted: bool,
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    OpsRequest::export_all(config).unwrap();
    OpsResult::export_all(config).unwrap();
}

pub(crate) async fn command(
    request: OpsRequest,
    runner: &dyn CommandRunner,
) -> Result<OpsResult, HostdError> {
    if request.task == OpsTask::Maintenance && request.confirmed != Some(true) {
        return Err(HostdError::validation(
            "Maintenance confirmation is required",
        ));
    }
    let unit = match request.task {
        OpsTask::Health => "sigmaos-health.service",
        OpsTask::Maintenance => "sigmaos-maintenance.service",
    };
    run_checked(runner, "systemctl", &["start", "--no-block", unit], None).await?;
    Ok(OpsResult {
        task: request.task,
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

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
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
                success: true,
            })
        }
    }

    async fn command_payload(
        payload: Value,
        runner: &dyn CommandRunner,
    ) -> Result<Value, HostdError> {
        let request: OpsRequest = serde_json::from_value(payload)
            .map_err(|_| HostdError::validation("Invalid system.ops payload"))?;
        serde_json::to_value(command(request, runner).await?)
            .map_err(|error| HostdError::operation_failed(error.to_string()))
    }

    #[tokio::test]
    async fn maps_tasks_to_fixed_non_blocking_units() {
        let runner = FakeRunner::default();
        assert_eq!(
            command_payload(json!({ "task": "health" }), &runner)
                .await
                .unwrap(),
            json!({ "task": "health", "accepted": true })
        );
        assert_eq!(
            command_payload(json!({ "task": "maintenance", "confirmed": true }), &runner)
                .await
                .unwrap(),
            json!({ "task": "maintenance", "accepted": true })
        );
        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[
                (
                    "systemctl".to_owned(),
                    vec![
                        "start".to_owned(),
                        "--no-block".to_owned(),
                        "sigmaos-health.service".to_owned()
                    ]
                ),
                (
                    "systemctl".to_owned(),
                    vec![
                        "start".to_owned(),
                        "--no-block".to_owned(),
                        "sigmaos-maintenance.service".to_owned()
                    ]
                )
            ]
        );
    }

    #[tokio::test]
    async fn rejects_missing_confirmation_and_injection_fields() {
        let runner = FakeRunner::default();
        for payload in [
            json!({ "task": "maintenance" }),
            json!({ "task": "maintenance", "confirmed": false }),
            json!({ "task": "unknown", "confirmed": true }),
            json!({ "task": "health", "unit": "attacker.service" }),
            json!({ "task": "health", "args": ["--now"] }),
        ] {
            assert!(command_payload(payload, &runner).await.is_err());
        }
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn repeated_health_starts_are_idempotent_at_the_command_boundary() {
        let runner = FakeRunner::default();
        for _ in 0..2 {
            command_payload(json!({ "task": "health" }), &runner)
                .await
                .unwrap();
        }
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
    }
}
