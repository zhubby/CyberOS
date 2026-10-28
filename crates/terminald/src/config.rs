use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use nix::unistd::{Uid, User};

use crate::error::TerminalError;

pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";
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
        let terminal_user =
            env::var("CYBEROS_TERMINALD_USER").unwrap_or_else(|_| "cyberos".to_owned());
        if terminal_user != "cyberos" {
            return Err(TerminalError::validation(
                "CYBEROS_TERMINALD_USER must be cyberos",
            ));
        }
        let account = resolve_account(&terminal_user)?;
        if Uid::current().as_raw() != account.uid {
            return Err(TerminalError::validation(
                "Terminal daemon must run as cyberos",
            ));
        }
        let socket_path =
            absolute_path_from_env("CYBEROS_TERMINALD_SOCKET_PATH", DEFAULT_SOCKET_PATH)?;
        let tmux_socket_path = match env::var("CYBEROS_TERMINALD_TMUX_SOCKET_PATH") {
            Ok(value) if !value.trim().is_empty() => validate_absolute_path(&value)?,
            _ => account.home.join(".cyberos/tmux.sock"),
        };
        Ok(Self {
            socket_path,
            tmux_socket_path,
            account,
            idle_timeout_ms: positive_u64_env(
                "CYBEROS_TERMINALD_SESSION_IDLE_TIMEOUT_MS",
                DEFAULT_IDLE_TIMEOUT_MS,
            )?,
            connect_timeout_ms: positive_u64_env(
                "CYBEROS_TERMINALD_CONNECT_TIMEOUT_MS",
                DEFAULT_CONNECT_TIMEOUT_MS,
            )?,
            max_sessions: positive_usize_env(
                "CYBEROS_TERMINALD_MAX_SESSIONS",
                DEFAULT_MAX_SESSIONS,
            )?,
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

fn absolute_path_from_env(name: &str, fallback: &str) -> Result<PathBuf, TerminalError> {
    let value = env::var(name).unwrap_or_else(|_| fallback.to_owned());
    validate_absolute_path(&value)
}

fn validate_absolute_path(value: &str) -> Result<PathBuf, TerminalError> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(TerminalError::validation(
            "Terminal socket paths must be absolute",
        ));
    }
    Ok(path.to_owned())
}

fn positive_u64_env(name: &str, fallback: u64) -> Result<u64, TerminalError> {
    match env::var(name) {
        Ok(value) => parse_positive_u64(name, &value),
        Err(env::VarError::NotPresent) => Ok(fallback),
        Err(env::VarError::NotUnicode(_)) => Err(TerminalError::validation(format!(
            "{name} must be a positive integer"
        ))),
    }
}

fn positive_usize_env(name: &str, fallback: usize) -> Result<usize, TerminalError> {
    match env::var(name) {
        Ok(value) => parse_positive_usize(name, &value),
        Err(env::VarError::NotPresent) => Ok(fallback),
        Err(env::VarError::NotUnicode(_)) => Err(TerminalError::validation(format!(
            "{name} must be a positive integer"
        ))),
    }
}

fn parse_positive_u64(name: &str, value: &str) -> Result<u64, TerminalError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| TerminalError::validation(format!("{name} must be a positive integer")))
}

fn parse_positive_usize(name: &str, value: &str) -> Result<usize, TerminalError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| TerminalError::validation(format!("{name} must be a positive integer")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_absolute_paths() {
        assert_eq!(
            validate_absolute_path("/run/cyberos/terminald.sock").unwrap(),
            PathBuf::from("/run/cyberos/terminald.sock")
        );
        assert!(validate_absolute_path("relative.sock").is_err());
    }

    #[test]
    fn rejects_invalid_positive_integer_settings() {
        assert_eq!(parse_positive_u64("TIMEOUT", "42").unwrap(), 42);
        assert_eq!(parse_positive_usize("MAX", "8").unwrap(), 8);
        assert!(parse_positive_u64("TIMEOUT", "0").is_err());
        assert!(parse_positive_u64("TIMEOUT", "invalid").is_err());
        assert!(parse_positive_usize("MAX", "0").is_err());
    }
}
