use serde::{Deserialize, Serialize};

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

const TV_MODE_COMMAND: &str = "/usr/lib/cyberos/scripts/cyberos-tv-mode";

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdTvRequest"))]
#[serde(deny_unknown_fields)]
pub(crate) struct TvRequest {
    enabled: bool,
    confirmed: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdTvResult"))]
pub(crate) struct TvResult {
    enabled: bool,
    #[cfg_attr(test, ts(type = "true"))]
    applied: bool,
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    TvRequest::export_all(config).unwrap();
    TvResult::export_all(config).unwrap();
}

pub(crate) async fn apply(
    request: TvRequest,
    runner: &dyn CommandRunner,
) -> Result<TvResult, HostdError> {
    if !request.confirmed {
        return Err(HostdError::validation("TV mode confirmation is required"));
    }
    let action = if request.enabled { "enable" } else { "disable" };
    run_checked(runner, TV_MODE_COMMAND, &[action], None).await?;
    Ok(TvResult {
        enabled: request.enabled,
        applied: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
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

    #[tokio::test]
    async fn maps_boolean_state_to_the_fixed_tv_mode_command() {
        let runner = FakeRunner::default();
        for enabled in [true, false] {
            let result = apply(
                TvRequest {
                    enabled,
                    confirmed: true,
                },
                &runner,
            )
            .await
            .unwrap();
            assert_eq!(result.enabled, enabled);
            assert!(result.applied);
        }
        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[
                (TV_MODE_COMMAND.to_owned(), vec!["enable".to_owned()]),
                (TV_MODE_COMMAND.to_owned(), vec!["disable".to_owned()])
            ]
        );
    }

    #[tokio::test]
    async fn rejects_unconfirmed_requests_without_running_a_command() {
        let runner = FakeRunner::default();
        assert!(
            apply(
                TvRequest {
                    enabled: true,
                    confirmed: false,
                },
                &runner,
            )
            .await
            .is_err()
        );
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}
