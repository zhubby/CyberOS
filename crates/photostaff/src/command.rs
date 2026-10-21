use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::{ErrorCode, PhotostaffError};

const CHILD_MEDIA_FD: i32 = 198;
const STDERR_TAIL_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct CommandLimits {
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_file_bytes: u64,
    pub max_address_space_bytes: u64,
}

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr_tail: String,
}

#[derive(Debug, Default, Clone)]
pub struct CommandRunner;

struct ProcessGroupGuard {
    process_group: Option<Pid>,
}

impl ProcessGroupGuard {
    fn new(process_group: Option<Pid>) -> Self {
        Self { process_group }
    }

    fn kill(&mut self, signal: Signal) {
        if let Some(process_group) = self.process_group {
            let _ = killpg(process_group, signal);
        }
    }

    fn disarm(&mut self) {
        self.process_group = None;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.kill(Signal::SIGKILL);
    }
}

impl CommandRunner {
    pub async fn run(
        &self,
        program: &str,
        arguments: &[String],
        source: Option<&File>,
        limits: &CommandLimits,
    ) -> Result<CommandOutput, PhotostaffError> {
        let mut command = Command::new(program);
        command
            .args(arguments)
            .env_clear()
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let source_fd = source.map(AsRawFd::as_raw_fd);
        let max_file_bytes = limits.max_file_bytes;
        let max_address_space_bytes = limits.max_address_space_bytes;
        // SAFETY: only async-signal-safe libc calls run between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if nix::libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(source_fd) = source_fd
                    && nix::libc::dup2(source_fd, CHILD_MEDIA_FD) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if source_fd.is_some()
                    && nix::libc::fcntl(CHILD_MEDIA_FD, nix::libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let file_limit = nix::libc::rlimit {
                    rlim_cur: max_file_bytes,
                    rlim_max: max_file_bytes,
                };
                if nix::libc::setrlimit(nix::libc::RLIMIT_FSIZE, &file_limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    let memory_limit = nix::libc::rlimit {
                        rlim_cur: max_address_space_bytes,
                        rlim_max: max_address_space_bytes,
                    };
                    if nix::libc::setrlimit(nix::libc::RLIMIT_AS, &memory_limit) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = max_address_space_bytes;
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                PhotostaffError::new(
                    ErrorCode::ToolUnavailable,
                    format!("Media tool is unavailable: {program}"),
                    true,
                )
            } else {
                PhotostaffError::storage(error)
            }
        })?;
        let process_group = child.id().map(|id| Pid::from_raw(id as i32));
        let mut process_group_guard = ProcessGroupGuard::new(process_group);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PhotostaffError::internal("Missing command stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| PhotostaffError::internal("Missing command stderr"))?;
        let mut stdout_task = tokio::spawn(read_bounded(stdout, limits.max_stdout_bytes, false));
        let mut stderr_task = tokio::spawn(read_bounded(stderr, STDERR_TAIL_BYTES, true));

        let completed = tokio::time::timeout(limits.timeout, async {
            let status = child.wait().await.map_err(PhotostaffError::storage)?;
            let (stdout, stdout_overflow) = (&mut stdout_task)
                .await
                .map_err(|error| PhotostaffError::internal(error.to_string()))??;
            let (stderr, _) = (&mut stderr_task)
                .await
                .map_err(|error| PhotostaffError::internal(error.to_string()))??;
            Ok::<_, PhotostaffError>((status, stdout, stdout_overflow, stderr))
        })
        .await;
        let (status, stdout, stdout_overflow, stderr) = match completed {
            Ok(result) => {
                process_group_guard.kill(Signal::SIGKILL);
                process_group_guard.disarm();
                result?
            }
            Err(_) => {
                process_group_guard.kill(Signal::SIGTERM);
                if tokio::time::timeout(Duration::from_secs(2), child.wait())
                    .await
                    .is_err()
                {
                    process_group_guard.kill(Signal::SIGKILL);
                    let _ = child.wait().await;
                }
                process_group_guard.kill(Signal::SIGKILL);
                process_group_guard.disarm();
                stdout_task.abort();
                stderr_task.abort();
                return Err(PhotostaffError::new(
                    ErrorCode::CommandTimeout,
                    format!("{program} exceeded its command timeout"),
                    true,
                ));
            }
        };
        let stderr_tail = sanitize_stderr(&stderr);
        if stdout_overflow {
            return Err(PhotostaffError::new(
                ErrorCode::CommandFailed,
                format!("{program} output exceeded its limit"),
                false,
            ));
        }
        if !status.success() {
            let (code, retryable) = classify_command_failure(&status, &stderr_tail);
            return Err(PhotostaffError::new(
                code,
                if stderr_tail.is_empty() {
                    format!("{program} exited with {status}")
                } else {
                    format!("{program} failed: {stderr_tail}")
                },
                retryable,
            ));
        }
        Ok(CommandOutput {
            stdout,
            stderr_tail,
        })
    }
}

pub fn child_media_path() -> &'static str {
    #[cfg(target_os = "linux")]
    return "/proc/self/fd/198";
    #[cfg(not(target_os = "linux"))]
    "/dev/fd/198"
}

async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    keep_tail: bool,
) -> Result<(Vec<u8>, bool), PhotostaffError> {
    let mut result = Vec::with_capacity(limit.min(8192));
    let mut overflow = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(PhotostaffError::storage)?;
        if count == 0 {
            break;
        }
        if keep_tail {
            if count >= limit {
                result.clear();
                result.extend_from_slice(&buffer[count - limit..count]);
                overflow = true;
            } else {
                let remove = result.len().saturating_add(count).saturating_sub(limit);
                if remove > 0 {
                    result.drain(..remove);
                    overflow = true;
                }
                result.extend_from_slice(&buffer[..count]);
            }
        } else if result.len() < limit {
            let take = count.min(limit - result.len());
            result.extend_from_slice(&buffer[..take]);
            overflow |= take < count;
        } else {
            overflow = true;
        }
    }
    Ok((result, overflow))
}

fn sanitize_stderr(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .map(|token| {
            if token
                .trim_start_matches(['\'', '"', '(', '['])
                .starts_with('/')
            {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn classify_command_failure(status: &std::process::ExitStatus, stderr: &str) -> (ErrorCode, bool) {
    if let Some(signal) = status.signal() {
        if signal == nix::libc::SIGXFSZ {
            return (ErrorCode::SizeLimit, false);
        }
        return (ErrorCode::CommandFailed, true);
    }
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("no space left") || lower.contains("disk quota") {
        return (ErrorCode::DiskSpace, false);
    }
    if lower.contains("permission denied") {
        return (ErrorCode::PermissionDenied, false);
    }
    if lower.contains("input/output error") || lower.contains("stale file handle") {
        return (ErrorCode::PhotostaffStorageUnavailable, true);
    }
    (ErrorCode::CorruptMedia, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_output_and_time_limits() {
        let runner = CommandRunner;
        let limits = CommandLimits {
            timeout: Duration::from_secs(2),
            max_stdout_bytes: 4,
            max_file_bytes: 1024 * 1024,
            max_address_space_bytes: 4 * 1024 * 1024 * 1024,
        };
        let error = runner
            .run("printf", &["12345".into()], None, &limits)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::CommandFailed, "{}", error.message);
    }

    #[tokio::test]
    async fn timeout_covers_descendants_that_keep_output_pipes_open() {
        let runner = CommandRunner;
        let limits = CommandLimits {
            timeout: Duration::from_millis(150),
            max_stdout_bytes: 1024,
            max_file_bytes: 1024 * 1024,
            max_address_space_bytes: 4 * 1024 * 1024 * 1024,
        };
        let started = tokio::time::Instant::now();
        let error = runner
            .run("sh", &["-c".into(), "sleep 30 &".into()], None, &limits)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::CommandTimeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn classifies_deterministic_rejections_and_redacts_paths() {
        let runner = CommandRunner;
        let limits = CommandLimits {
            timeout: Duration::from_secs(2),
            max_stdout_bytes: 1024,
            max_file_bytes: 1024 * 1024,
            max_address_space_bytes: 4 * 1024 * 1024 * 1024,
        };
        let error = runner
            .run(
                "sh",
                &[
                    "-c".into(),
                    "printf 'invalid media at /private/library/file.raw\\n' >&2; exit 2".into(),
                ],
                None,
                &limits,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::CorruptMedia);
        assert!(!error.retryable);
        assert!(!error.message.contains("/private/library"));
    }
}
