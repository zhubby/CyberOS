mod devices;
mod fstab;
mod model;
mod validation;

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
#[cfg(test)]
use serde_json::Value;
use tokio::fs;

use crate::command::{CommandRunner, DEFAULT_OUTPUT_LIMIT, run_checked};
use crate::error::HostdError;

pub use devices::cleanup_orphan_md_devices;
use devices::{
    assert_array_members, assert_devices_available, assert_mountpoint_available,
    assert_path_missing,
};
use fstab::{append_entry, mount_unit_name, remove_entry};
pub use model::StorageOptions;
pub(crate) use model::{StorageCommand, StorageOperation, StorageResult};
use validation::{validate_command, validate_operation};

const READ_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const READ_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdStorageCommandResult"))]
pub(crate) struct StorageCommandResult {
    pub stdout: String,
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    StorageCommand::export_all(config).unwrap();
    StorageCommandResult::export_all(config).unwrap();
    StorageOperation::export_all(config).unwrap();
    StorageResult::export_all(config).unwrap();
}

pub(crate) async fn command(
    request: StorageCommand,
    runner: &dyn CommandRunner,
) -> Result<StorageCommandResult, HostdError> {
    validate_command(&request)?;
    let output = runner
        .run(
            &request.command,
            &request.args,
            None,
            READ_COMMAND_TIMEOUT,
            READ_OUTPUT_LIMIT,
        )
        .await?;
    if output.success || !output.stdout.trim().is_empty() {
        return Ok(StorageCommandResult {
            stdout: output.stdout,
        });
    }
    Err(HostdError::operation_failed(
        if output.stderr.trim().is_empty() {
            format!("{} failed", request.command)
        } else {
            output.stderr
        },
    ))
}

pub(crate) async fn operation(
    request: StorageOperation,
    runner: &dyn CommandRunner,
) -> Result<StorageResult, HostdError> {
    execute_operation_with_options(request, runner, &StorageOptions::default()).await
}

async fn execute_operation_with_options(
    operation: StorageOperation,
    runner: &dyn CommandRunner,
    options: &StorageOptions,
) -> Result<StorageResult, HostdError> {
    validate_operation(&operation)?;
    let result = match &operation {
        StorageOperation::CreatePool { .. } => create_pool(&operation, runner, options).await?,
        StorageOperation::DeletePool { .. } => delete_pool(&operation, runner, options).await?,
    };
    Ok(result)
}

#[cfg(test)]
async fn operation_with_options(
    payload: Value,
    runner: &dyn CommandRunner,
    options: &StorageOptions,
) -> Result<Value, HostdError> {
    let operation: StorageOperation = serde_json::from_value(payload)
        .map_err(|_| HostdError::validation("Invalid storage operation request"))?;
    let result = execute_operation_with_options(operation, runner, options).await?;
    serde_json::to_value(result).map_err(|error| HostdError::operation_failed(error.to_string()))
}

async fn create_pool(
    operation: &StorageOperation,
    runner: &dyn CommandRunner,
    options: &StorageOptions,
) -> Result<StorageResult, HostdError> {
    let StorageOperation::CreatePool {
        name,
        raid_level,
        devices,
        filesystem,
        mountpoint,
        ..
    } = operation
    else {
        unreachable!()
    };
    if cleanup_orphan_md_devices(runner, &options.sys_block_path).await? {
        run_checked(runner, "udevadm", &["settle"], None).await?;
    }
    let stale_devices = assert_devices_available(devices, runner, &options.sys_block_path).await?;
    fs::create_dir_all(&options.mdadm_runtime_path).await?;
    let actual_mountpoint = options.mount_root.join(name);
    let mountpoint_existed =
        assert_mountpoint_available(&actual_mountpoint, &options.mount_root).await?;
    let md_device = options.md_device_root.join(name);
    assert_path_missing(&md_device).await?;
    fs::create_dir_all(md_device.parent().unwrap_or(&options.md_device_root)).await?;

    let mut created = false;
    let mut mounted = false;
    let mut previous_fstab: Option<String> = None;
    let result = async {
        if !stale_devices.is_empty() {
            let mut args = vec!["--zero-superblock".to_owned(), "--force".to_owned()];
            args.extend(stale_devices.clone());
            run_checked_owned(runner, "mdadm", &args).await?;
            run_checked(runner, "udevadm", &["settle"], None).await?;
        }
        let mut create_args = vec![
            "--create".to_owned(),
            md_device.to_string_lossy().into_owned(),
            "--run".to_owned(),
            "--force".to_owned(),
            "--metadata=1.2".to_owned(),
            format!("--level={raid_level}"),
            format!("--raid-devices={}", devices.len()),
        ];
        create_args.extend(devices.clone());
        run_checked_owned(runner, "mdadm", &create_args).await?;
        created = true;
        run_checked(runner, "udevadm", &["settle"], None).await?;
        let md_device_text = md_device.to_string_lossy().into_owned();
        let format_args = if filesystem == "btrfs" {
            vec![
                "-f".to_owned(),
                "-L".to_owned(),
                name.clone(),
                md_device_text,
            ]
        } else {
            vec![
                "-F".to_owned(),
                "-L".to_owned(),
                name.clone(),
                md_device_text,
            ]
        };
        run_checked_owned(
            runner,
            if filesystem == "btrfs" {
                "mkfs.btrfs"
            } else {
                "mkfs.ext4"
            },
            &format_args,
        )
        .await?;
        fs::create_dir_all(&actual_mountpoint).await?;
        run_checked(
            runner,
            "mount",
            &[
                &md_device.to_string_lossy(),
                &actual_mountpoint.to_string_lossy(),
            ],
            None,
        )
        .await?;
        mounted = true;
        find_mount(runner, &actual_mountpoint).await?;
        run_checked(
            runner,
            "chown",
            &["cyberos:cyberos", &actual_mountpoint.to_string_lossy()],
            None,
        )
        .await?;
        run_checked(
            runner,
            "setfacl",
            &[
                "-m",
                "u:cyberos:rwx,d:u:cyberos:rwx",
                &actual_mountpoint.to_string_lossy(),
            ],
            None,
        )
        .await?;
        let uuid = run_checked(
            runner,
            "blkid",
            &["-s", "UUID", "-o", "value", &md_device.to_string_lossy()],
            None,
        )
        .await?
        .trim()
        .to_owned();
        if uuid.is_empty()
            || !uuid
                .chars()
                .all(|character| character.is_ascii_hexdigit() || character == '-')
        {
            return Err(HostdError::operation_failed(
                "Unable to read the new pool UUID",
            ));
        }
        previous_fstab =
            Some(append_entry(&uuid, mountpoint, filesystem, &options.fstab_path).await?);
        run_checked(runner, "systemctl", &["daemon-reload"], None).await?;
        run_checked(
            runner,
            "systemctl",
            &["start", &mount_unit_name(mountpoint)],
            None,
        )
        .await?;
        find_mount(runner, mountpoint).await?;
        Ok::<String, HostdError>(uuid)
    }
    .await;

    match result {
        Ok(uuid) => Ok(StorageResult::CreatePool {
            name: name.clone(),
            raid_level: raid_level.clone(),
            devices: devices.clone(),
            filesystem: filesystem.clone(),
            mountpoint: mountpoint.clone(),
            md_device,
            uuid,
        }),
        Err(error) => {
            if let Some(previous) = previous_fstab {
                let _ = fstab::replace(&options.fstab_path, &previous).await;
                best_effort(runner, "systemctl", &["daemon-reload"]).await;
            }
            if mounted {
                best_effort(runner, "umount", &[&actual_mountpoint.to_string_lossy()]).await;
            }
            if !mountpoint_existed {
                let _ = fs::remove_dir(&actual_mountpoint).await;
            }
            if created {
                best_effort(runner, "mdadm", &["--stop", &md_device.to_string_lossy()]).await;
                let mut args = vec!["--zero-superblock".to_owned(), "--force".to_owned()];
                args.extend(devices.clone());
                let _ = run_checked_owned(runner, "mdadm", &args).await;
            } else {
                let _ = cleanup_orphan_md_devices(runner, &options.sys_block_path).await;
            }
            Err(error)
        }
    }
}

async fn delete_pool(
    operation: &StorageOperation,
    runner: &dyn CommandRunner,
    options: &StorageOptions,
) -> Result<StorageResult, HostdError> {
    let StorageOperation::DeletePool {
        name,
        md_device,
        devices,
        mountpoint,
        ..
    } = operation
    else {
        unreachable!()
    };
    // The server holds storage_lock for both pool deletion and iSCSI mutations.
    // Retained images still own space in this pool and must be destroyed explicitly.
    crate::iscsi::assert_pool_unused(&options.mount_root, name).await?;
    assert_array_members(md_device, devices, runner).await?;
    let previous_fstab = remove_entry(mountpoint, &options.fstab_path).await?;
    let mut array_stopped = false;
    let result = async {
        run_checked(runner, "systemctl", &["daemon-reload"], None).await?;
        run_checked(runner, "umount", &[&mountpoint.to_string_lossy()], None).await?;
        run_checked(
            runner,
            "mdadm",
            &["--stop", &md_device.to_string_lossy()],
            None,
        )
        .await?;
        array_stopped = true;
        run_checked(runner, "udevadm", &["settle"], None).await?;
        let mut args = vec!["--zero-superblock".to_owned(), "--force".to_owned()];
        args.extend(devices.clone());
        run_checked_owned(runner, "mdadm", &args).await
    }
    .await;
    if let Err(error) = result {
        if !array_stopped {
            let _ = fstab::replace(&options.fstab_path, &previous_fstab).await;
            best_effort(runner, "systemctl", &["daemon-reload"]).await;
            best_effort(runner, "mount", &[&mountpoint.to_string_lossy()]).await;
        }
        return Err(error);
    }
    Ok(StorageResult::DeletePool {
        name: name.clone(),
        mountpoint: mountpoint.clone(),
        md_device: md_device.clone(),
        devices: devices.clone(),
    })
}

async fn find_mount(runner: &dyn CommandRunner, target: &Path) -> Result<(), HostdError> {
    run_checked(
        runner,
        "findmnt",
        &[
            "--target",
            &target.to_string_lossy(),
            "--output",
            "SOURCE,FSTYPE",
            "--noheadings",
        ],
        None,
    )
    .await
    .map(|_| ())
}

async fn run_checked_owned(
    runner: &dyn CommandRunner,
    command: &str,
    args: &[String],
) -> Result<String, HostdError> {
    let output = runner
        .run(
            command,
            args,
            None,
            crate::command::DEFAULT_COMMAND_TIMEOUT,
            DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(HostdError::operation_failed(
            if output.stderr.trim().is_empty() {
                format!("{command} failed")
            } else {
                output.stderr
            },
        ))
    }
}

async fn best_effort(runner: &dyn CommandRunner, command: &str, args: &[&str]) {
    let _ = run_checked(runner, command, args, None).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        fail_command: Option<String>,
        fail_args_prefix: Option<Vec<String>>,
        stale_raid: bool,
        array_members: Option<Vec<String>>,
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
            self.calls
                .lock()
                .unwrap()
                .push((command.to_owned(), args.to_vec()));
            let success = self.fail_command.as_deref() != Some(command)
                && self
                    .fail_args_prefix
                    .as_ref()
                    .is_none_or(|prefix| !args.starts_with(prefix));
            let stdout = match command {
                "lsblk" => serde_json::json!({
                    "blockdevices": args.iter().filter(|arg| arg.starts_with("/dev/")).map(|path| {
                        serde_json::json!({
                            "path": path,
                            "type": "disk",
                            "fstype": self.stale_raid.then_some("linux_raid_member"),
                            "mountpoints": [null]
                        })
                    }).collect::<Vec<_>>()
                })
                .to_string(),
                "blkid" => "01234567-89ab-cdef\n".to_owned(),
                "mdadm" if args.starts_with(&["--detail".to_owned(), "--export".to_owned()]) => {
                    self.array_members
                        .clone()
                        .unwrap_or_else(|| vec!["/dev/sda".to_owned(), "/dev/sdb".to_owned()])
                        .iter()
                        .enumerate()
                        .map(|(index, device)| format!("MD_DEVICE_dev_{index}_DEV={device}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
                _ => String::new(),
            };
            Ok(crate::command::CommandOutput {
                stdout,
                stderr: if success {
                    String::new()
                } else {
                    "forced failure".to_owned()
                },
                success,
            })
        }
    }

    fn options(temp: &TempDir) -> StorageOptions {
        StorageOptions {
            fstab_path: temp.path().join("fstab"),
            mount_root: temp.path().join("nas"),
            md_device_root: temp.path().join("dev/md"),
            mdadm_runtime_path: temp.path().join("run/mdadm"),
            sys_block_path: temp.path().join("sys/block"),
        }
    }

    #[test]
    fn allows_only_read_only_storage_commands() {
        assert!(
            validate_command(&StorageCommand {
                command: "mdadm".to_owned(),
                args: vec!["--detail".to_owned(), "/dev/md/data".to_owned()]
            })
            .is_ok()
        );
        assert!(
            validate_command(&StorageCommand {
                command: "smartctl".to_owned(),
                args: vec![
                    "--all".to_owned(),
                    "--json".to_owned(),
                    "/dev/sda".to_owned()
                ]
            })
            .is_ok()
        );
        assert!(
            validate_command(&StorageCommand {
                command: "mdadm".to_owned(),
                args: vec!["--stop".to_owned(), "/dev/md0".to_owned()]
            })
            .is_err()
        );
        assert!(
            validate_command(&StorageCommand {
                command: "mdadm".to_owned(),
                args: vec!["--detail".to_owned(), "/dev/sda".to_owned()]
            })
            .is_err()
        );
    }

    #[test]
    fn validates_raid_disk_counts_and_paths() {
        let invalid = serde_json::from_value::<StorageOperation>(serde_json::json!({
            "action": "create_pool", "name": "data", "raidLevel": "5",
            "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "ext4",
            "mountpoint": "/cyberos/data/data", "risk": "high"
        }))
        .unwrap();
        assert!(validate_operation(&invalid).is_err());
        let escape = serde_json::from_value::<StorageOperation>(serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/md/data",
            "devices": ["/dev/sda"], "mountpoint": "/mnt/other", "risk": "high"
        }))
        .unwrap();
        assert!(validate_operation(&escape).is_err());
        let non_raid_device = serde_json::from_value::<StorageOperation>(serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/sda",
            "devices": ["/dev/sdb"], "mountpoint": "/cyberos/data/data", "risk": "high"
        }))
        .unwrap();
        assert!(validate_operation(&non_raid_device).is_err());
    }

    #[tokio::test]
    async fn stops_only_clear_orphan_arrays_without_holders() {
        let temp = TempDir::new().unwrap();
        let clear = temp.path().join("md0");
        let active = temp.path().join("md1");
        fs::create_dir_all(clear.join("md")).await.unwrap();
        fs::create_dir_all(clear.join("holders")).await.unwrap();
        fs::create_dir_all(active.join("md")).await.unwrap();
        fs::create_dir_all(active.join("holders")).await.unwrap();
        fs::write(clear.join("md/array_state"), "clear\n")
            .await
            .unwrap();
        fs::write(active.join("md/array_state"), "active\n")
            .await
            .unwrap();
        let runner = FakeRunner::default();
        assert!(
            cleanup_orphan_md_devices(&runner, temp.path())
                .await
                .unwrap()
        );
        let calls = runner.calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|(_, args)| args == &vec!["--stop".to_owned(), "/dev/md0".to_owned()])
        );
        assert!(
            !calls
                .iter()
                .any(|(_, args)| args.contains(&"/dev/md1".to_owned()))
        );
    }

    #[tokio::test]
    async fn preserves_clear_orphan_arrays_with_block_holders() {
        let temp = TempDir::new().unwrap();
        let device = temp.path().join("md0");
        fs::create_dir_all(device.join("md")).await.unwrap();
        fs::create_dir_all(device.join("holders")).await.unwrap();
        fs::write(device.join("md/array_state"), "clear\n")
            .await
            .unwrap();
        fs::write(device.join("holders/dm-0"), "").await.unwrap();
        let runner = FakeRunner::default();

        assert!(
            !cleanup_orphan_md_devices(&runner, temp.path())
                .await
                .unwrap()
        );
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_stale_raid_members_that_still_have_holders() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(options.sys_block_path.join("sda/holders"))
            .await
            .unwrap();
        fs::write(options.sys_block_path.join("sda/holders/md0"), "")
            .await
            .unwrap();
        let runner = FakeRunner {
            stale_raid: true,
            ..FakeRunner::default()
        };

        let error =
            assert_devices_available(&["/dev/sda".to_owned()], &runner, &options.sys_block_path)
                .await
                .unwrap_err();

        assert_eq!(error.code, crate::error::ErrorCode::Validation);
        assert!(error.message.contains("active RAID array"));
    }

    #[tokio::test]
    async fn creates_pool_and_persists_fstab_entry() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.mount_root).await.unwrap();
        fs::create_dir_all(&options.sys_block_path).await.unwrap();
        fs::write(&options.fstab_path, "# fstab\n").await.unwrap();
        fs::set_permissions(&options.fstab_path, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        let payload = serde_json::json!({
            "action": "create_pool", "name": "data", "raidLevel": "1",
            "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "ext4",
            "mountpoint": "/cyberos/data/data", "risk": "high"
        });
        let runner = FakeRunner::default();
        operation_with_options(payload, &runner, &options)
            .await
            .unwrap();
        assert!(
            fs::read_to_string(&options.fstab_path)
                .await
                .unwrap()
                .contains("UUID=01234567-89ab-cdef /cyberos/data/data ext4")
        );
        assert_eq!(
            fs::metadata(&options.fstab_path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, _)| command == "mkfs.ext4"));
        let mount_index = calls
            .iter()
            .position(|(command, _)| command == "mount")
            .unwrap();
        let chown_index = calls
            .iter()
            .position(|(command, args)| {
                command == "chown"
                    && args
                        == &[
                            "cyberos:cyberos",
                            &options.mount_root.join("data").to_string_lossy(),
                        ]
            })
            .unwrap();
        assert!(chown_index > mount_index);
        assert!(
            calls
                .iter()
                .position(|(command, args)| command == "setfacl"
                    && args
                        .iter()
                        .any(|arg| arg == "u:cyberos:rwx,d:u:cyberos:rwx"))
                .is_some_and(|index| index > chown_index)
        );
        assert!(calls.iter().any(|(command, args)| command == "systemctl"
            && args.contains(&"cyberos-data-data.mount".to_owned())));
    }

    #[tokio::test]
    async fn formats_btrfs_pools_with_the_matching_fstab_type() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.mount_root).await.unwrap();
        fs::create_dir_all(&options.sys_block_path).await.unwrap();
        fs::write(&options.fstab_path, "# fstab\n").await.unwrap();
        let payload = serde_json::json!({
            "action": "create_pool", "name": "archive", "raidLevel": "1",
            "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "btrfs",
            "mountpoint": "/cyberos/data/archive", "risk": "high"
        });
        let runner = FakeRunner::default();

        operation_with_options(payload, &runner, &options)
            .await
            .unwrap();

        assert!(
            fs::read_to_string(&options.fstab_path)
                .await
                .unwrap()
                .contains("UUID=01234567-89ab-cdef /cyberos/data/archive btrfs")
        );
        assert!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(command, _)| command == "mkfs.btrfs")
        );
    }

    #[tokio::test]
    async fn rolls_back_a_created_pool_when_systemd_activation_fails() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.mount_root).await.unwrap();
        fs::create_dir_all(&options.sys_block_path).await.unwrap();
        fs::write(&options.fstab_path, "# fstab\n").await.unwrap();
        let payload = serde_json::json!({
            "action": "create_pool", "name": "data", "raidLevel": "1",
            "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "ext4",
            "mountpoint": "/cyberos/data/data", "risk": "high"
        });
        let runner = FakeRunner {
            fail_command: Some("systemctl".to_owned()),
            ..FakeRunner::default()
        };

        assert!(
            operation_with_options(payload, &runner, &options)
                .await
                .is_err()
        );

        assert_eq!(
            fs::read_to_string(&options.fstab_path).await.unwrap(),
            "# fstab\n"
        );
        assert!(!options.mount_root.join("data").exists());
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, _)| command == "umount"));
        assert!(calls.iter().any(|(command, args)| {
            command == "mdadm" && args.starts_with(&["--stop".to_owned()])
        }));
        assert!(calls.iter().any(|(command, args)| {
            command == "mdadm" && args.starts_with(&["--zero-superblock".to_owned()])
        }));
    }

    #[tokio::test]
    async fn rolls_back_if_the_mounted_pool_cannot_be_made_writable() {
        for failure in ["chown", "setfacl"] {
            let temp = TempDir::new().unwrap();
            let options = options(&temp);
            fs::create_dir_all(&options.mount_root).await.unwrap();
            fs::create_dir_all(&options.sys_block_path).await.unwrap();
            fs::write(&options.fstab_path, "# fstab\n").await.unwrap();
            let runner = FakeRunner {
                fail_command: Some(failure.to_owned()),
                ..FakeRunner::default()
            };
            let payload = serde_json::json!({
                "action": "create_pool", "name": "data", "raidLevel": "1",
                "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "ext4",
                "mountpoint": "/cyberos/data/data", "risk": "high"
            });

            assert!(
                operation_with_options(payload, &runner, &options)
                    .await
                    .is_err()
            );
            assert_eq!(
                fs::read_to_string(&options.fstab_path).await.unwrap(),
                "# fstab\n"
            );
            assert!(!options.mount_root.join("data").exists());
            assert!(
                runner
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(command, _)| command == "umount")
            );
        }
    }

    #[tokio::test]
    async fn rolls_back_a_created_array_when_mount_verification_fails() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.mount_root).await.unwrap();
        fs::create_dir_all(&options.sys_block_path).await.unwrap();
        fs::write(&options.fstab_path, "# fstab\n").await.unwrap();
        let runner = FakeRunner {
            fail_command: Some("findmnt".to_owned()),
            ..FakeRunner::default()
        };
        let payload = serde_json::json!({
            "action": "create_pool", "name": "data", "raidLevel": "1",
            "devices": ["/dev/sda", "/dev/sdb"], "filesystem": "ext4",
            "mountpoint": "/cyberos/data/data", "risk": "high"
        });

        assert!(
            operation_with_options(payload, &runner, &options)
                .await
                .is_err()
        );

        assert_eq!(
            fs::read_to_string(&options.fstab_path).await.unwrap(),
            "# fstab\n"
        );
        assert!(!options.mount_root.join("data").exists());
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, _)| command == "umount"));
        assert!(calls.iter().any(|(command, args)| {
            command == "mdadm" && args.starts_with(&["--stop".to_owned()])
        }));
    }

    #[tokio::test]
    async fn refuses_pool_deletion_with_retained_iscsi_images_before_any_host_change() {
        let temp = TempDir::new().unwrap();
        let mut options = options(&temp);
        options.mount_root = fs::canonicalize(temp.path()).await.unwrap().join("data");
        let state_dir = options
            .mount_root
            .parent()
            .unwrap()
            .join("state/hostd/iscsi");
        fs::create_dir_all(&state_dir).await.unwrap();
        fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let registry = serde_json::json!({
            "version": 1, "targets": [],
            "images": [{
                "id": "27f9f605-a5e5-4421-84f1-8b41d8973710", "name": "retained",
                "storagePoolId": "data", "sizeBytes": 1073741824, "attachedTargetId": null
            }]
        });
        fs::write(state_dir.join("state.json"), registry.to_string())
            .await
            .unwrap();
        fs::set_permissions(
            state_dir.join("state.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/md/data",
            "devices": ["/dev/sda", "/dev/sdb"], "mountpoint": "/cyberos/data/data", "risk": "high"
        });
        let runner = FakeRunner::default();
        let error = operation_with_options(payload, &runner, &options)
            .await
            .unwrap_err();
        assert_eq!(error.status, 409);
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deletes_a_pool_after_removing_its_fstab_entry() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::write(
            &options.fstab_path,
            "# fstab\nUUID=x /cyberos/data/data ext4 defaults 0 2\n",
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/md/data",
            "devices": ["/dev/sda", "/dev/sdb"], "mountpoint": "/cyberos/data/data", "risk": "high"
        });
        let runner = FakeRunner::default();

        let result = operation_with_options(payload, &runner, &options)
            .await
            .unwrap();

        assert_eq!(result["action"], "delete_pool");
        assert_eq!(
            fs::read_to_string(&options.fstab_path).await.unwrap(),
            "# fstab\n"
        );
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, _)| command == "umount"));
        assert!(calls.iter().any(|(command, args)| {
            command == "mdadm" && args.starts_with(&["--zero-superblock".to_owned()])
        }));
    }

    #[tokio::test]
    async fn restores_fstab_when_delete_cannot_stop_array() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::write(
            &options.fstab_path,
            "UUID=x /cyberos/data/data ext4 defaults 0 2\n",
        )
        .await
        .unwrap();
        let runner = FakeRunner {
            fail_args_prefix: Some(vec!["--stop".to_owned()]),
            ..FakeRunner::default()
        };
        let payload = serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/md/data",
            "devices": ["/dev/sda", "/dev/sdb"], "mountpoint": "/cyberos/data/data", "risk": "high"
        });
        assert!(
            operation_with_options(payload, &runner, &options)
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(&options.fstab_path).await.unwrap(),
            "UUID=x /cyberos/data/data ext4 defaults 0 2\n"
        );
    }

    #[tokio::test]
    async fn rejects_delete_when_array_members_changed() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let original_fstab = "UUID=x /cyberos/data/data ext4 defaults 0 2\n";
        fs::write(&options.fstab_path, original_fstab)
            .await
            .unwrap();
        let runner = FakeRunner {
            array_members: Some(vec!["/dev/sda".to_owned(), "/dev/sdc".to_owned()]),
            ..FakeRunner::default()
        };
        let payload = serde_json::json!({
            "action": "delete_pool", "name": "data", "mdDevice": "/dev/md/data",
            "devices": ["/dev/sda", "/dev/sdb"], "mountpoint": "/cyberos/data/data", "risk": "high"
        });

        let error = operation_with_options(payload, &runner, &options)
            .await
            .unwrap_err();

        assert_eq!(error.code, crate::error::ErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(&options.fstab_path).await.unwrap(),
            original_fstab
        );
        assert!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .all(|(command, _)| command != "umount")
        );
    }
}
