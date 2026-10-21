use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::timeout;

use crate::error::{ErrorCode, HostdError};

pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        input: Option<&[u8]>,
        command_timeout: Duration,
        output_limit: usize,
    ) -> Result<CommandOutput, HostdError>;
}

#[derive(Debug, Default)]
pub struct SystemCommandRunner;

#[async_trait]
impl CommandRunner for SystemCommandRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        input: Option<&[u8]>,
        command_timeout: Duration,
        output_limit: usize,
    ) -> Result<CommandOutput, HostdError> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| HostdError::unavailable(format!("{command} is unavailable")))?;

        let mut stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HostdError::operation_failed("Could not capture command stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| HostdError::operation_failed("Could not capture command stderr"))?;
        let execution = async {
            let write_input = async {
                if let Some(mut stdin) = stdin.take() {
                    if let Some(input) = input {
                        stdin.write_all(input).await?;
                    }
                    stdin.shutdown().await?;
                }
                Ok::<(), HostdError>(())
            };
            let outputs = async {
                tokio::try_join!(
                    read_bounded(stdout, output_limit, command),
                    read_bounded(stderr, output_limit, command),
                )
            };
            let wait = async { Ok::<_, HostdError>(child.wait().await?) };
            let (status, (), (stdout, stderr)) = tokio::try_join!(wait, write_input, outputs)?;
            Ok::<_, HostdError>((status, stdout, stderr))
        };
        let (status, stdout, stderr) =
            timeout(command_timeout, execution).await.map_err(|_| {
                HostdError::new(504, ErrorCode::Timeout, format!("{command} timed out"))
            })??;
        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            success: status.success(),
        })
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    command: &str,
) -> Result<Vec<u8>, HostdError> {
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(HostdError::new(
                502,
                ErrorCode::OutputTooLarge,
                format!("{command} output exceeded the limit"),
            ));
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

pub async fn run_checked(
    runner: &dyn CommandRunner,
    command: &str,
    args: &[impl AsRef<str> + Sync],
    input: Option<&[u8]>,
) -> Result<String, HostdError> {
    let args = args
        .iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect::<Vec<_>>();
    let output = runner
        .run(
            command,
            &args,
            input,
            DEFAULT_COMMAND_TIMEOUT,
            DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if output.success {
        return Ok(output.stdout);
    }
    let message = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    Err(HostdError::operation_failed(if message.is_empty() {
        format!("{command} failed")
    } else {
        message.to_owned()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_output_limits_while_reading() {
        let error = SystemCommandRunner
            .run(
                "sh",
                &["-c".to_owned(), "printf 123456".to_owned()],
                None,
                Duration::from_secs(1),
                5,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::OutputTooLarge);
    }

    #[tokio::test]
    async fn terminates_commands_that_exceed_the_timeout() {
        let error = SystemCommandRunner
            .run(
                "sh",
                &["-c".to_owned(), "sleep 1".to_owned()],
                None,
                Duration::from_millis(10),
                DEFAULT_OUTPUT_LIMIT,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Timeout);
    }

    #[tokio::test]
    async fn includes_stdin_writes_in_the_command_timeout() {
        let input = vec![b'x'; 1024 * 1024];
        let error = SystemCommandRunner
            .run(
                "sh",
                &["-c".to_owned(), "sleep 1".to_owned()],
                Some(&input),
                Duration::from_millis(10),
                DEFAULT_OUTPUT_LIMIT,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Timeout);
    }
}
