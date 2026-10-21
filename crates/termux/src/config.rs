use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use nix::unistd::{Uid, User};

use crate::error::TermuxError;

pub const DEFAULT_CONFIG_PATH: &str = "/zos/config/config.toml";
pub const DEFAULT_SOCKET_PATH: &str = "/run/zos/termux.sock";
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
pub struct TermuxConfig {
    pub socket_path: PathBuf,
    pub tmux_socket_path: PathBuf,
    pub account: Account,
    pub idle_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub max_sessions: usize,
}

impl TermuxConfig {
    pub fn load() -> Result<Self, TermuxError> {
        let terminal_user = env::var("ZOS_TERMUX_USER").unwrap_or_else(|_| "zos".to_owned());
        if terminal_user != "zos" {
            return Err(TermuxError::validation("ZOS_TERMUX_USER must be zos"));
        }
        let account = resolve_account(&terminal_user)?;
        if Uid::current().as_raw() != account.uid {
            return Err(TermuxError::validation("Termux daemon must run as zos"));
        }
        let socket_path = absolute_path_from_env("ZOS_TERMUX_SOCKET_PATH", DEFAULT_SOCKET_PATH)?;
        let tmux_socket_path = match env::var("ZOS_TERMUX_TMUX_SOCKET_PATH") {
            Ok(value) if !value.trim().is_empty() => validate_absolute_path(&value)?,
            _ => account.home.join(".zos/tmux.sock"),
        };
        Ok(Self {
            socket_path,
            tmux_socket_path,
            account,
            idle_timeout_ms: positive_u64_env(
                "ZOS_TERMUX_SESSION_IDLE_TIMEOUT_MS",
                DEFAULT_IDLE_TIMEOUT_MS,
            ),
            connect_timeout_ms: positive_u64_env(
                "ZOS_TERMUX_CONNECT_TIMEOUT_MS",
                DEFAULT_CONNECT_TIMEOUT_MS,
            ),
            max_sessions: positive_usize_env("ZOS_TERMUX_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
        })
    }
}

fn resolve_account(name: &str) -> Result<Account, TermuxError> {
    let user = User::from_name(name)
        .map_err(|error| TermuxError::unavailable(error.to_string()))?
        .ok_or_else(|| TermuxError::validation("Terminal account does not exist"))?;
    if user.uid.is_root() || !user.dir.is_absolute() || !user.shell.is_absolute() {
        return Err(TermuxError::validation("Invalid terminal account"));
    }
    let home_metadata = std::fs::metadata(&user.dir)
        .map_err(|_| TermuxError::validation("Terminal home is not accessible"))?;
    let shell_metadata = std::fs::metadata(&user.shell)
        .map_err(|_| TermuxError::validation("Terminal shell is not accessible"))?;
    if !home_metadata.is_dir() || shell_metadata.permissions().mode() & 0o111 == 0 {
        return Err(TermuxError::validation("Invalid terminal home or shell"));
    }
    Ok(Account {
        name: user.name,
        uid: user.uid.as_raw(),
        gid: user.gid.as_raw(),
        home: user.dir,
        shell: user.shell,
    })
}

fn absolute_path_from_env(name: &str, fallback: &str) -> Result<PathBuf, TermuxError> {
    let value = env::var(name).unwrap_or_else(|_| fallback.to_owned());
    validate_absolute_path(&value)
}

fn validate_absolute_path(value: &str) -> Result<PathBuf, TermuxError> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(TermuxError::validation(
            "Termux socket paths must be absolute",
        ));
    }
    Ok(path.to_owned())
}

fn positive_u64_env(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn positive_usize_env(name: &str, fallback: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_absolute_paths() {
        assert_eq!(
            validate_absolute_path("/run/zos/termux.sock").unwrap(),
            PathBuf::from("/run/zos/termux.sock")
        );
        assert!(validate_absolute_path("relative.sock").is_err());
    }
}
