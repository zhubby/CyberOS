use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::config::Account;
use crate::error::TerminalError;
use crate::session_policy::{ManagedSession, eviction_candidate, should_reap};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct TmuxManager {
    socket_path: PathBuf,
    account: Account,
    max_sessions: usize,
    command_lock: Arc<Mutex<()>>,
}

impl TmuxManager {
    pub fn new(socket_path: PathBuf, account: Account, max_sessions: usize) -> Self {
        Self {
            socket_path,
            account,
            max_sessions,
            command_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn ensure_available(&self) -> Result<(), TerminalError> {
        let mut command = Command::new("tmux");
        command.arg("-V");
        let output = timeout(COMMAND_TIMEOUT, command.output())
            .await
            .map_err(|_| TerminalError::timeout("Timed out checking tmux availability"))??;
        if !output.status.success() {
            return Err(TerminalError::unavailable(
                "tmux is required for persistent terminal sessions",
            ));
        }
        Ok(())
    }

    pub async fn ensure_session(
        &self,
        session_name: &str,
        persistent: bool,
    ) -> Result<(), TerminalError> {
        let _guard = self.command_lock.lock().await;
        if self.has_session_unlocked(session_name).await? {
            self.set_option_unlocked(session_name, "@cyberos_managed", "1")
                .await?;
            self.set_option_unlocked(
                session_name,
                "@cyberos_persistent",
                if persistent { "1" } else { "0" },
            )
            .await?;
            self.set_option_unlocked(session_name, "@cyberos_detached_at", "0")
                .await?;
            return Ok(());
        }

        let sessions = self.list_managed_unlocked().await?;
        if sessions.len() >= self.max_sessions {
            let candidate = eviction_candidate(&sessions)
                .ok_or_else(TerminalError::session_limit)?
                .name
                .clone();
            self.destroy_unlocked(&candidate).await?;
        }

        self.run_checked_unlocked([
            "new-session",
            "-d",
            "-s",
            session_name,
            "-c",
            self.account.home.to_string_lossy().as_ref(),
        ])
        .await?;
        let initialization = async {
            self.set_option_unlocked(session_name, "@cyberos_managed", "1")
                .await?;
            self.set_option_unlocked(
                session_name,
                "@cyberos_persistent",
                if persistent { "1" } else { "0" },
            )
            .await?;
            self.set_option_unlocked(session_name, "@cyberos_detached_at", "0")
                .await
        }
        .await;
        if let Err(error) = initialization {
            if let Err(cleanup_error) = self.destroy_unlocked(session_name).await {
                tracing::warn!(
                    session = session_name,
                    message = %cleanup_error.message,
                    "unable to remove partially initialized tmux session"
                );
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn mark_attached(&self, session_name: &str) -> Result<(), TerminalError> {
        let _guard = self.command_lock.lock().await;
        self.set_option_unlocked(session_name, "@cyberos_detached_at", "0")
            .await
    }

    pub async fn mark_detached(&self, session_name: &str) -> Result<(), TerminalError> {
        let _guard = self.command_lock.lock().await;
        if !self.has_session_unlocked(session_name).await? {
            return Ok(());
        }
        self.set_option_unlocked(
            session_name,
            "@cyberos_detached_at",
            &current_time_ms().to_string(),
        )
        .await
    }

    pub async fn resize(
        &self,
        session_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let _guard = self.command_lock.lock().await;
        let cols = cols.to_string();
        let rows = rows.to_string();
        self.run_checked_unlocked([
            "resize-window",
            "-t",
            session_name,
            "-x",
            &cols,
            "-y",
            &rows,
        ])
        .await
        .map(|_| ())
    }

    pub async fn destroy(&self, session_name: &str) -> Result<(), TerminalError> {
        let _guard = self.command_lock.lock().await;
        self.destroy_unlocked(session_name).await
    }

    pub async fn has_session(&self, session_name: &str) -> Result<bool, TerminalError> {
        let _guard = self.command_lock.lock().await;
        self.has_session_unlocked(session_name).await
    }

    pub async fn reap_expired(&self, idle_timeout_ms: u64) -> Result<Vec<String>, TerminalError> {
        let _guard = self.command_lock.lock().await;
        let now = current_time_ms();
        let sessions = self.list_managed_unlocked().await?;
        let mut reaped = Vec::new();
        for session in sessions
            .iter()
            .filter(|session| should_reap(session, now, idle_timeout_ms))
        {
            self.destroy_unlocked(&session.name).await?;
            reaped.push(session.name.clone());
        }
        Ok(reaped)
    }

    pub fn attach_command(&self, session_name: &str) -> Command {
        let mut command = Command::new("tmux");
        command
            .arg("-S")
            .arg(&self.socket_path)
            .args(["attach-session", "-t", session_name]);
        self.configure_environment(&mut command);
        command
    }

    async fn set_option_unlocked(
        &self,
        session_name: &str,
        option: &str,
        value: &str,
    ) -> Result<(), TerminalError> {
        self.run_checked_unlocked(["set-option", "-t", session_name, option, value])
            .await
            .map(|_| ())
    }

    async fn has_session_unlocked(&self, session_name: &str) -> Result<bool, TerminalError> {
        let output = self
            .run_unlocked(["has-session", "-t", session_name])
            .await?;
        Ok(output.status.success())
    }

    async fn destroy_unlocked(&self, session_name: &str) -> Result<(), TerminalError> {
        let output = self
            .run_unlocked(["kill-session", "-t", session_name])
            .await?;
        if output.status.success() || is_missing_session(&output.stderr) {
            return Ok(());
        }
        Err(command_error(
            "Unable to destroy tmux session",
            &output.stderr,
        ))
    }

    async fn list_managed_unlocked(&self) -> Result<Vec<ManagedSession>, TerminalError> {
        let output = self
            .run_unlocked([
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_attached}\t#{@cyberos_managed}\t#{@cyberos_detached_at}\t#{@cyberos_persistent}",
            ])
            .await?;
        if !output.status.success() {
            if is_missing_session(&output.stderr) {
                return Ok(Vec::new());
            }
            return Err(command_error(
                "Unable to list tmux sessions",
                &output.stderr,
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\t');
                let name = fields.next()?.to_owned();
                let attached = fields.next()?.parse().ok()?;
                let managed = fields.next()? == "1";
                let detached_at_ms = fields.next()?.parse().unwrap_or(0);
                let persistent = fields.next() == Some("1");
                (managed && is_managed_name(&name)).then_some(ManagedSession {
                    name,
                    attached,
                    detached_at_ms,
                    persistent,
                })
            })
            .collect())
    }

    async fn run_checked_unlocked<const N: usize>(
        &self,
        arguments: [&str; N],
    ) -> Result<std::process::Output, TerminalError> {
        let output = self.run_unlocked(arguments).await?;
        if !output.status.success() {
            return Err(command_error("tmux command failed", &output.stderr));
        }
        Ok(output)
    }

    async fn run_unlocked<const N: usize>(
        &self,
        arguments: [&str; N],
    ) -> Result<std::process::Output, TerminalError> {
        let mut command = Command::new("tmux");
        command.arg("-S").arg(&self.socket_path).args(arguments);
        self.configure_environment(&mut command);
        timeout(COMMAND_TIMEOUT, command.output())
            .await
            .map_err(|_| TerminalError::timeout("tmux command timed out"))?
            .map_err(Into::into)
    }

    fn configure_environment(&self, command: &mut Command) {
        command
            .current_dir(&self.account.home)
            .env("HOME", &self.account.home)
            .env("USER", &self.account.name)
            .env("LOGNAME", &self.account.name)
            .env("SHELL", &self.account.shell)
            .env("PWD", &self.account.home)
            .env("TERM", "xterm-256color");
    }
}

fn command_error(context: &str, stderr: &[u8]) -> TerminalError {
    let details = String::from_utf8_lossy(stderr);
    let details = details.trim();
    TerminalError::operation_failed(if details.is_empty() {
        context.to_owned()
    } else {
        format!("{context}: {details}")
    })
}

fn is_missing_session(stderr: &[u8]) -> bool {
    let details = String::from_utf8_lossy(stderr);
    details.contains("can't find session")
        || details.contains("no server running")
        || details.contains("No such file or directory")
}

fn is_managed_name(name: &str) -> bool {
    name.starts_with("cyberos-")
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_managed_names_and_missing_sessions() {
        assert!(is_managed_name("cyberos-demo_1"));
        assert!(!is_managed_name("other-demo"));
        assert!(!is_managed_name("cyberos-BAD"));
        assert!(is_missing_session(b"can't find session: demo"));
    }
}
