mod model;
mod store;

use std::path::Path;

#[cfg(test)]
use serde_json::Value;
use tokio::fs;
use uuid::Uuid;

use crate::command::{CommandRunner, run_checked};
use crate::error::{ErrorCode, HostdError};

pub use model::DockerOptions;
#[cfg(test)]
use model::MAX_CONFIG_BYTES;
pub(crate) use model::{DockerRequest, DockerResult};
use model::{DockerUpdateInput, DockerUpdateResult, RollbackStatus, validate_input};
use store::{
    atomic_write, atomic_write_checked, clear_transaction, conflict, create_baseline,
    ensure_revision, read_config_file, read_snapshot, read_transaction, revision, rollback_config,
    write_transaction,
};

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    DockerRequest::export_all(config).unwrap();
    DockerResult::export_all(config).unwrap();
}

pub(crate) async fn handle(
    request: DockerRequest,
    runner: &dyn CommandRunner,
) -> Result<DockerResult, HostdError> {
    execute_with_options(request, runner, &DockerOptions::default()).await
}

async fn execute_with_options(
    request: DockerRequest,
    runner: &dyn CommandRunner,
    options: &DockerOptions,
) -> Result<DockerResult, HostdError> {
    match request {
        DockerRequest::Read => Ok(DockerResult::Snapshot(read_snapshot(options).await?)),
        DockerRequest::Update { input } => {
            validate_input(&input)?;
            Ok(DockerResult::Update(update(input, runner, options).await?))
        }
    }
}

#[cfg(test)]
async fn handle_with_options(
    payload: Value,
    runner: &dyn CommandRunner,
    options: &DockerOptions,
) -> Result<Value, HostdError> {
    let request: DockerRequest = serde_json::from_value(payload)
        .map_err(|_| HostdError::validation("Invalid Docker daemon request"))?;
    let result = execute_with_options(request, runner, options).await?;
    serde_json::to_value(result).map_err(|error| HostdError::operation_failed(error.to_string()))
}

async fn update(
    input: DockerUpdateInput,
    runner: &dyn CommandRunner,
    options: &DockerOptions,
) -> Result<DockerUpdateResult, HostdError> {
    let mut current = read_config_file(&options.config_path).await?;
    ensure_revision(&current, &input.expected_revision, "saving")?;
    assert_dockerd_available(runner).await?;
    validate_content(&input.content, &options.config_path, runner).await?;
    current = read_config_file(&options.config_path).await?;
    ensure_revision(&current, &input.expected_revision, "saving")?;

    let mut transaction = read_transaction(&options.state_dir).await?;
    let next_revision = revision(true, &input.content);
    let content_changed = current.revision != next_revision;
    if (content_changed || input.restart) && transaction.is_none() {
        transaction = Some(create_baseline(&options.state_dir, &current).await?);
    }
    if content_changed {
        let expected = input.expected_revision.clone();
        atomic_write_checked(
            &options.config_path,
            input.content.as_bytes(),
            0o644,
            || async {
                let latest = read_config_file(&options.config_path).await?;
                ensure_revision(&latest, &expected, "saving")
            },
        )
        .await?;
        let transaction = transaction
            .as_mut()
            .expect("transaction exists for a changed file");
        transaction.pending_revision.clone_from(&next_revision);
        write_transaction(&options.state_dir, transaction).await?;
    } else if input.restart
        && transaction
            .as_ref()
            .is_some_and(|transaction| transaction.pending_revision != next_revision)
    {
        let transaction = transaction
            .as_mut()
            .expect("transaction exists for restart");
        transaction.pending_revision.clone_from(&next_revision);
        write_transaction(&options.state_dir, transaction).await?;
    }

    if !input.restart {
        let snapshot = read_snapshot(options).await?;
        if snapshot.revision != next_revision {
            return Err(conflict("saving"));
        }
        return Ok(DockerUpdateResult {
            snapshot,
            restarted: false,
            rollback: RollbackStatus::NotRequired,
            error: None,
        });
    }

    let restart_candidate = read_config_file(&options.config_path).await?;
    ensure_revision(&restart_candidate, &next_revision, "restarting")?;
    if run_checked(runner, "systemctl", &["restart", "docker.service"], None)
        .await
        .is_ok()
    {
        clear_transaction(&options.state_dir).await?;
        return Ok(DockerUpdateResult {
            snapshot: read_snapshot(options).await?,
            restarted: true,
            rollback: RollbackStatus::NotRequired,
            error: None,
        });
    }

    let transaction = transaction.expect("transaction exists for restart");
    let rollback = rollback_config(options, &transaction, runner).await;
    let message = match rollback {
        RollbackStatus::Succeeded => {
            "Docker restart failed; the last applied configuration was restored"
        }
        _ => "Docker restart and automatic rollback failed; manual recovery is required",
    };
    let result = DockerUpdateResult {
        snapshot: read_snapshot(options).await?,
        restarted: false,
        rollback,
        error: Some(message.to_owned()),
    };
    Err(HostdError::new(502, ErrorCode::RestartFailed, message)
        .with_details(serde_json::json!({ "result": result })))
}

async fn assert_dockerd_available(runner: &dyn CommandRunner) -> Result<(), HostdError> {
    run_checked(runner, "dockerd", &["--version"], None)
        .await
        .map(|_| ())
        .map_err(|_| HostdError::unavailable("Docker daemon is not installed or unavailable"))
}

async fn validate_content(
    content: &str,
    config_path: &Path,
    runner: &dyn CommandRunner,
) -> Result<(), HostdError> {
    let parent = config_path
        .parent()
        .ok_or_else(|| HostdError::validation("Docker config path has no parent"))?;
    fs::create_dir_all(parent).await?;
    let validation_path = parent.join(format!(".zos-daemon-{}.json", Uuid::new_v4()));
    let result = async {
        atomic_write(&validation_path, content.as_bytes(), 0o600).await?;
        run_checked(
            runner,
            "dockerd",
            &[
                "--validate",
                "--config-file",
                &validation_path.to_string_lossy(),
            ],
            None,
        )
        .await?;
        Ok::<(), HostdError>(())
    }
    .await;
    let _ = fs::remove_file(&validation_path).await;
    result.map_err(|_| HostdError::validation("Docker daemon rejected the configuration"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;
    use tempfile::TempDir;

    struct FakeRunner {
        restart_results: Mutex<VecDeque<bool>>,
        edit_after_validation: Mutex<Option<(PathBuf, String)>>,
        edit_before_failed_restart: Mutex<Option<(PathBuf, String)>>,
        fail_validation: bool,
    }

    impl FakeRunner {
        fn new(restart_results: impl IntoIterator<Item = bool>) -> Self {
            Self {
                restart_results: Mutex::new(restart_results.into_iter().collect()),
                edit_after_validation: Mutex::new(None),
                edit_before_failed_restart: Mutex::new(None),
                fail_validation: false,
            }
        }

        fn with_validation_edit(self, path: PathBuf, content: &str) -> Self {
            *self.edit_after_validation.lock().unwrap() = Some((path, content.to_owned()));
            self
        }

        fn with_restart_failure_edit(self, path: PathBuf, content: &str) -> Self {
            *self.edit_before_failed_restart.lock().unwrap() = Some((path, content.to_owned()));
            self
        }

        fn with_validation_failure(mut self) -> Self {
            self.fail_validation = true;
            self
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            _input: Option<&[u8]>,
            _timeout: Duration,
            _output_limit: usize,
        ) -> Result<crate::command::CommandOutput, HostdError> {
            let restarting = command == "systemctl" && args == ["restart", "docker.service"];
            let validating = command == "dockerd"
                && args
                    .first()
                    .is_some_and(|argument| argument == "--validate");
            let success = if validating && self.fail_validation {
                false
            } else if restarting {
                self.restart_results
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(true)
            } else {
                true
            };
            if validating
                && let Some((path, content)) = self.edit_after_validation.lock().unwrap().take()
            {
                std::fs::write(path, content).unwrap();
            }
            if restarting
                && !success
                && let Some((path, content)) =
                    self.edit_before_failed_restart.lock().unwrap().take()
            {
                std::fs::write(path, content).unwrap();
            }
            Ok(crate::command::CommandOutput {
                stdout: String::new(),
                stderr: if success {
                    String::new()
                } else {
                    "restart failed".to_owned()
                },
                success,
            })
        }
    }

    fn options(temp: &TempDir) -> DockerOptions {
        DockerOptions {
            config_path: temp.path().join("etc/docker/daemon.json"),
            state_dir: temp.path().join("state"),
        }
    }

    async fn update_payload(options: &DockerOptions, content: &str, restart: bool) -> Value {
        let current = read_config_file(&options.config_path).await.unwrap();
        serde_json::json!({
            "action": "update",
            "input": {
                "content": content,
                "expectedRevision": current.revision,
                "restart": restart,
                "confirmed": restart
            }
        })
    }

    #[tokio::test]
    async fn saves_a_valid_config_and_keeps_the_first_baseline() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.config_path, "{\"debug\":false}\n")
            .await
            .unwrap();
        let runner = FakeRunner::new([]);
        handle_with_options(
            update_payload(&options, "{\"debug\":true}\n", false).await,
            &runner,
            &options,
        )
        .await
        .unwrap();
        handle_with_options(
            update_payload(&options, "{\"log-level\":\"warn\"}\n", false).await,
            &runner,
            &options,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(options.state_dir.join("baseline.json"))
                .await
                .unwrap(),
            "{\"debug\":false}\n"
        );
    }

    #[tokio::test]
    async fn clears_transaction_after_successful_restart() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner::new([true]);
        handle_with_options(
            update_payload(&options, "{}\n", true).await,
            &runner,
            &options,
        )
        .await
        .unwrap();
        assert!(!options.state_dir.join("transaction.json").exists());
    }

    #[tokio::test]
    async fn restores_baseline_when_restart_fails() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.config_path, "{\"debug\":false}\n")
            .await
            .unwrap();
        let runner = FakeRunner::new([false, true]);
        let error = handle_with_options(
            update_payload(&options, "{\"debug\":true}\n", true).await,
            &runner,
            &options,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::RestartFailed);
        assert_eq!(
            fs::read_to_string(&options.config_path).await.unwrap(),
            "{\"debug\":false}\n"
        );
        assert!(!options.state_dir.join("transaction.json").exists());
    }

    #[tokio::test]
    async fn preserves_recovery_material_when_restart_and_rollback_fail() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner::new([false, false]);
        let error = handle_with_options(
            update_payload(&options, "{\"debug\":true}\n", true).await,
            &runner,
            &options,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::RestartFailed);
        assert!(options.state_dir.join("transaction.json").exists());
    }

    #[tokio::test]
    async fn preserves_an_external_edit_made_during_validation() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.config_path, "{\"log-level\":\"info\"}\n")
            .await
            .unwrap();
        let payload = update_payload(&options, "{\"log-level\":\"debug\"}\n", false).await;
        let runner = FakeRunner::new([])
            .with_validation_edit(options.config_path.clone(), "{\"log-level\":\"warn\"}\n");

        let error = handle_with_options(payload, &runner, &options)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(&options.config_path).await.unwrap(),
            "{\"log-level\":\"warn\"}\n"
        );
    }

    #[tokio::test]
    async fn preserves_the_config_when_dockerd_rejects_a_candidate() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.config_path, "{\"log-level\":\"info\"}\n")
            .await
            .unwrap();
        let payload = update_payload(&options, "{\"unknown-option\":true}\n", false).await;
        let runner = FakeRunner::new([]).with_validation_failure();

        let error = handle_with_options(payload, &runner, &options)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Validation);
        assert_eq!(
            fs::read_to_string(&options.config_path).await.unwrap(),
            "{\"log-level\":\"info\"}\n"
        );
    }

    #[tokio::test]
    async fn preserves_an_external_edit_when_restart_rollback_is_unsafe() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.config_path, "{\"log-level\":\"info\"}\n")
            .await
            .unwrap();
        let payload = update_payload(&options, "{\"log-level\":\"debug\"}\n", true).await;
        let runner = FakeRunner::new([false])
            .with_restart_failure_edit(options.config_path.clone(), "{\"log-level\":\"warn\"}\n");

        let error = handle_with_options(payload, &runner, &options)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::RestartFailed);
        assert_eq!(
            fs::read_to_string(&options.config_path).await.unwrap(),
            "{\"log-level\":\"warn\"}\n"
        );
        assert!(options.state_dir.join("transaction.json").exists());
        assert_eq!(
            fs::read_to_string(options.state_dir.join("baseline.json"))
                .await
                .unwrap(),
            "{\"log-level\":\"info\"}\n"
        );
    }

    #[tokio::test]
    async fn rejects_stale_revisions_and_invalid_json() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner::new([]);
        let stale = serde_json::json!({
            "action": "update",
            "input": { "content": "{}", "expectedRevision": "0".repeat(64), "restart": false, "confirmed": false }
        });
        assert_eq!(
            handle_with_options(stale, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let invalid = serde_json::json!({
            "action": "update",
            "input": { "content": "[]", "expectedRevision": revision(false, ""), "restart": false, "confirmed": false }
        });
        assert_eq!(
            handle_with_options(invalid, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        let malformed = serde_json::json!({
            "action": "update",
            "input": { "content": "{", "expectedRevision": revision(false, ""), "restart": false, "confirmed": false }
        });
        assert_eq!(
            handle_with_options(malformed, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        let oversized = serde_json::json!({
            "action": "update",
            "input": {
                "content": format!("{{\"value\":\"{}\"}}", "x".repeat(MAX_CONFIG_BYTES)),
                "expectedRevision": revision(false, ""), "restart": false, "confirmed": false
            }
        });
        assert_eq!(
            handle_with_options(oversized, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        let unconfirmed_restart = serde_json::json!({
            "action": "update",
            "input": {
                "content": "{}", "expectedRevision": revision(false, ""),
                "restart": true, "confirmed": false
            }
        });
        assert_eq!(
            handle_with_options(unconfirmed_restart, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }

    #[tokio::test]
    async fn rejects_symlinked_config_files() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.config_path.parent().unwrap())
            .await
            .unwrap();
        let target = temp.path().join("daemon-target.json");
        fs::write(&target, "{}\n").await.unwrap();
        std::os::unix::fs::symlink(&target, &options.config_path).unwrap();

        assert_eq!(
            read_snapshot(&options).await.unwrap_err().code,
            ErrorCode::Validation
        );
    }
}
