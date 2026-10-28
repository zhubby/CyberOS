use std::os::unix::fs::PermissionsExt;

use nix::unistd::{Gid, Group, Uid, chown};
use tokio::fs;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::model::{SharePaths, ShareSettings};

pub(super) async fn apply_credentials(
    settings: &ShareSettings,
    paths: &SharePaths,
    runner: &dyn CommandRunner,
    group: &str,
) -> Result<(), HostdError> {
    if let Some(password) = settings.account.password.as_deref() {
        if let Some(parent) = paths.htpasswd.parent() {
            fs::create_dir_all(parent).await?;
        }
        run_checked(
            runner,
            "htpasswd",
            &[
                "-Bci",
                &paths.htpasswd.to_string_lossy(),
                &settings.account.username,
            ],
            Some(format!("{password}\n").as_bytes()),
        )
        .await?;
    }
    let credentials_exist = fs::try_exists(&paths.htpasswd).await?;
    if credentials_exist {
        fs::set_permissions(&paths.htpasswd, std::fs::Permissions::from_mode(0o640)).await?;
    }
    if credentials_exist
        && Uid::effective().is_root()
        && let Some(group) = Group::from_name(group)
            .map_err(|error| HostdError::operation_failed(error.to_string()))?
    {
        let _ = chown(
            &paths.htpasswd,
            Some(Uid::from_raw(0)),
            Some(Gid::from_raw(group.gid.as_raw())),
        );
    }
    let Some(password) = settings.account.password.as_deref() else {
        return Ok(());
    };
    let id = runner
        .run(
            "id",
            &["-u".to_owned(), settings.account.username.clone()],
            None,
            crate::command::DEFAULT_COMMAND_TIMEOUT,
            crate::command::DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if !id.success {
        run_checked(
            runner,
            "useradd",
            &[
                "--system",
                "--no-create-home",
                "--home-dir",
                "/cyberos/home/share",
                "--shell",
                "/usr/sbin/nologin",
                &settings.account.username,
            ],
            None,
        )
        .await?;
    }
    run_checked(
        runner,
        "smbpasswd",
        &["-s", "-a", &settings.account.username],
        Some(format!("{password}\n{password}\n").as_bytes()),
    )
    .await?;
    run_checked(
        runner,
        "smbpasswd",
        &["-e", &settings.account.username],
        None,
    )
    .await?;
    Ok(())
}
