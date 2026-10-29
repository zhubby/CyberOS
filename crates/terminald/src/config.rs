use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use nix::unistd::{Uid, User};

use crate::error::TerminalError;

pub const DEFAULT_SOCKET_PATH: &str = "/run/cyberos/terminald.sock";
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 30 * 60 * 1000;
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 10 * 1000;
pub const DEFAULT_MAX_SESSIONS: usize = 32;

#[derive(Debug, Clone)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
    pub shell: PathBuf,
}

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub socket_path: PathBuf,
    pub tmux_socket_path: PathBuf,
    pub account: Account,
    pub idle_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub max_sessions: usize,
}

impl TerminalConfig {
    pub fn load() -> Result<Self, TerminalError> {
        let terminal_user = "cyberos";
        let account = resolve_account(terminal_user)?;
        if Uid::current().as_raw() != account.uid {
            return Err(TerminalError::validation(
                "Terminal daemon must run as cyberos",
            ));
        }
        let socket_path = PathBuf::from(DEFAULT_SOCKET_PATH);
        let tmux_socket_path = account.home.join(".cyberos/tmux.sock");
        Ok(Self {
            socket_path,
            tmux_socket_path,
            account,
            idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
            max_sessions: DEFAULT_MAX_SESSIONS,
        })
    }
}

fn resolve_account(name: &str) -> Result<Account, TerminalError> {
    let user = User::from_name(name)
        .map_err(|error| TerminalError::unavailable(error.to_string()))?
        .ok_or_else(|| TerminalError::validation("Terminal account does not exist"))?;
    if user.uid.is_root() || !user.dir.is_absolute() || !user.shell.is_absolute() {
        return Err(TerminalError::validation("Invalid terminal account"));
    }
    let home_metadata = std::fs::metadata(&user.dir)
        .map_err(|_| TerminalError::validation("Terminal home is not accessible"))?;
    let shell_metadata = std::fs::metadata(&user.shell)
        .map_err(|_| TerminalError::validation("Terminal shell is not accessible"))?;
    if !home_metadata.is_dir() || shell_metadata.permissions().mode() & 0o111 == 0 {
        return Err(TerminalError::validation("Invalid terminal home or shell"));
    }
    Ok(Account {
        name: user.name,
        uid: user.uid.as_raw(),
        gid: user.gid.as_raw(),
        home: user.dir,
        shell: user.shell,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_socket_is_absolute() {
        assert!(PathBuf::from(DEFAULT_SOCKET_PATH).is_absolute());
    }
}
