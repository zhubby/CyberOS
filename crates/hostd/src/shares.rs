mod acl;
mod credentials;
mod files;
mod model;
mod render;
mod validation;

use std::collections::BTreeSet;

#[cfg(test)]
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::command::{CommandRunner, DEFAULT_COMMAND_TIMEOUT, DEFAULT_OUTPUT_LIMIT, run_checked};
use crate::error::HostdError;

use credentials::apply_credentials;
use files::{restore_files, snapshot_files, write_managed_file};
use model::ALL_SERVICES;
pub(crate) use model::ShareApplyResult;
pub use model::{
    DlnaConfig, FtpConfig, NfsConfig, ResolvedShare, ShareAccount, ShareApplyRequest,
    ShareDefinition, ShareOptions, SharePaths, ShareProtocols, ShareSettings, SmbConfig,
    WebDavConfig,
};
pub use render::{
    render_dlna, render_ftp, render_ftp_pam, render_nfs, render_samba, render_webdav,
};
use validation::{resolve_shares, validate_request, validate_requested_data_root};

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    ShareApplyRequest::export_all(config).unwrap();
    ShareApplyResult::export_all(config).unwrap();
}

pub(crate) async fn apply(
    request: ShareApplyRequest,
    runner: &dyn CommandRunner,
    configured_data_root: &std::path::Path,
) -> Result<ShareApplyResult, HostdError> {
    apply_with_options(
        &request,
        runner,
        &ShareOptions::default(),
        configured_data_root,
    )
    .await
}

async fn apply_with_options(
    request: &ShareApplyRequest,
    runner: &dyn CommandRunner,
    options: &ShareOptions,
    configured_data_root: &std::path::Path,
) -> Result<ShareApplyResult, HostdError> {
    validate_request(request)?;
    validate_requested_data_root(&request.data_root, configured_data_root)?;
    let resolved = resolve_shares(&request.settings, configured_data_root).await?;
    let files = vec![
        (
            options.paths.samba_config.clone(),
            render_samba(&request.settings, &resolved)?,
        ),
        (
            options.paths.webdav_site.clone(),
            render_webdav(&request.settings, &resolved, &options.paths.htpasswd)?,
        ),
        (
            options.paths.ftp_config.clone(),
            render_ftp(&request.settings, &resolved, &options.paths.ftp_pam)?,
        ),
        (
            options.paths.nfs_exports.clone(),
            render_nfs(&request.settings, &resolved)?,
        ),
        (
            options.paths.dlna_config.clone(),
            render_dlna(&request.settings, &resolved)?,
        ),
        (
            options.paths.ftp_pam.clone(),
            render_ftp_pam(&options.paths.htpasswd),
        ),
    ];
    let services = services_for_settings(&request.settings);
    let service_actions = ALL_SERVICES
        .iter()
        .map(|service| {
            let action = if services.iter().any(|enabled| enabled == service) {
                if *service == "vsftpd.service" {
                    "restart"
                } else {
                    "reload-or-restart"
                }
            } else if matches!(
                *service,
                "cyberos-webdav.service" | "vsftpd.service" | "minidlna.service"
            ) {
                "stop"
            } else {
                "try-reload-or-restart"
            };
            ((*service).to_owned(), action)
        })
        .collect::<Vec<_>>();
    let snapshot = snapshot_files(files.iter().map(|(path, _)| path.as_path())).await?;
    let mut attempted_services = Vec::new();
    let mut acl_transaction = None;

    let operation = async {
        apply_credentials(
            &request.settings,
            &options.paths,
            runner,
            &options.credential_group,
        )
        .await?;
        acl_transaction = Some(acl::prepare(runner, options, &request.settings, &resolved).await?);
        for (path, content) in &files {
            let mode = if path == &options.paths.webdav_site || path == &options.paths.dlna_config {
                0o644
            } else {
                0o640
            };
            write_managed_file(path, content, &options.managed_roots, mode).await?;
        }
        for (service, action) in &service_actions {
            let state = runner
                .run(
                    "systemctl",
                    &["is-active".to_owned(), service.clone()],
                    None,
                    DEFAULT_COMMAND_TIMEOUT,
                    DEFAULT_OUTPUT_LIMIT,
                )
                .await?;
            let was_active = state.success && state.stdout.trim() == "active";
            if !matches!(*action, "reload-or-restart" | "restart") && !was_active {
                continue;
            }
            attempted_services.push((service.clone(), was_active));
            run_checked(runner, "systemctl", &[*action, service.as_str()], None).await?;
        }
        if let Some(transaction) = &acl_transaction {
            acl::command(runner, options, "commit", None, Some(transaction)).await?;
        }
        Ok::<(), HostdError>(())
    }
    .await;
    if let Err(error) = operation {
        restore_files(&snapshot).await;
        let rollback_error = if let Some(transaction) = &acl_transaction {
            acl::command(runner, options, "rollback", None, Some(transaction))
                .await
                .err()
        } else {
            None
        };
        for (service, was_active) in attempted_services.iter().rev() {
            let action = if *was_active {
                if service == "vsftpd.service" {
                    "restart"
                } else {
                    "reload-or-restart"
                }
            } else {
                "stop"
            };
            let _ = run_checked(runner, "systemctl", &[action, service.as_str()], None).await;
        }
        if let Some(rollback_error) = rollback_error {
            return Err(HostdError::operation_failed(format!(
                "{}; ACL rollback failed: {} (backup: {})",
                error.message,
                rollback_error.message,
                acl_transaction.unwrap_or_default()
            )));
        }
        return Err(error);
    }

    Ok(ShareApplyResult {
        applied_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| HostdError::operation_failed(error.to_string()))?,
        files: files
            .iter()
            .map(|(path, _)| path.to_string_lossy().into_owned())
            .collect(),
        services,
    })
}

fn services_for_settings(settings: &ShareSettings) -> Vec<String> {
    if !settings.enabled {
        return Vec::new();
    }
    let mut services = BTreeSet::new();
    for share in &settings.shares {
        if share.protocols.smb.enabled {
            services.extend(["smbd.service", "nmbd.service"]);
        }
        if share.protocols.webdav.enabled {
            services.insert("cyberos-webdav.service");
        }
        if share.protocols.ftp.enabled {
            services.insert("vsftpd.service");
        }
        if share.protocols.nfs.enabled {
            services.insert("nfs-server.service");
        }
        if share.protocols.dlna.enabled {
            services.insert("minidlna.service");
        }
    }
    ALL_SERVICES
        .iter()
        .filter(|service| services.contains(**service))
        .map(|service| (*service).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::fs;

    type CommandCall = (String, Vec<String>, Option<Vec<u8>>);

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<CommandCall>>,
        fail_service: Option<String>,
        missing_user: bool,
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            input: Option<&[u8]>,
            _timeout: Duration,
            _output_limit: usize,
        ) -> Result<crate::command::CommandOutput, HostdError> {
            self.calls.lock().unwrap().push((
                command.to_owned(),
                args.to_vec(),
                input.map(<[u8]>::to_vec),
            ));
            let success = self
                .fail_service
                .as_ref()
                .is_none_or(|service| !args.contains(service))
                && !(command == "id" && self.missing_user);
            Ok(crate::command::CommandOutput {
                stdout: if args.first().is_some_and(|action| action == "is-active") {
                    "active\n".to_owned()
                } else {
                    String::new()
                },
                stderr: if success {
                    String::new()
                } else {
                    "reload failed".to_owned()
                },
                success,
            })
        }
    }

    fn fixture(data_root: &Path) -> ShareApplyRequest {
        let data_root = std::fs::canonicalize(data_root).unwrap_or_else(|_| data_root.to_owned());
        serde_json::from_value(serde_json::json!({
            "settings": {
                "enabled": true,
                "account": { "username": "cyberos_share", "password": null },
                "shares": [{
                    "id": "media", "name": "Media", "description": "LAN media",
                    "storagePoolId": "pool-1", "path": "media",
                    "protocols": {
                        "smb": { "enabled": true, "readOnly": false, "browseable": true, "allowGuest": false },
                        "webdav": { "enabled": true, "readOnly": true, "allowGuest": false, "port": 8088, "pathPrefix": "/shares/media" },
                        "ftp": { "enabled": true, "readOnly": true, "allowGuest": false, "port": 2121, "passivePortStart": 50000, "passivePortEnd": 50100 },
                        "nfs": { "enabled": true, "readOnly": true, "allowedCidrs": ["192.168.1.0/24"], "rootSquash": true },
                        "dlna": { "enabled": true, "mediaTypes": ["audio", "video"], "bindInterface": "eth0", "bindAddress": null, "friendlyName": "CyberOS Media" }
                    }
                }]
            },
            "dataRoot": data_root
        }))
        .unwrap()
    }

    fn test_options(temp: &TempDir) -> ShareOptions {
        let etc = temp.path().join("etc");
        ShareOptions {
            paths: SharePaths {
                samba_config: etc.join("samba/cyberos.conf"),
                webdav_site: etc.join("apache/cyberos.conf"),
                ftp_config: etc.join("vsftpd/cyberos.conf"),
                nfs_exports: etc.join("exports/cyberos.exports"),
                dlna_config: etc.join("minidlna/cyberos.conf"),
                htpasswd: etc.join("cyberos/shares.htpasswd"),
                ftp_pam: etc.join("pam/vsftpd-cyberos"),
            },
            // Source-package tests run before the cyberos group is installed.
            credential_group: "root".to_owned(),
            managed_roots: vec![etc],
            acl_script: temp.path().join("share-acl.mjs"),
            acl_state: temp.path().join("share-acl.json"),
        }
    }

    #[tokio::test]
    async fn renders_configs_and_reloads_only_enabled_services() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let request = fixture(&temp.path().join("data"));
        let options = test_options(&temp);
        let runner = FakeRunner::default();
        let result = apply_with_options(&request, &runner, &options, &request.data_root)
            .await
            .unwrap();
        assert_eq!(result.services, ALL_SERVICES);
        let samba = fs::read_to_string(&options.paths.samba_config)
            .await
            .unwrap();
        assert!(samba.contains("[cyberos-media]"));
        assert!(samba.contains("valid users = cyberos_share"));
        assert_eq!(
            fs::metadata(&options.paths.samba_config)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        assert_eq!(
            fs::metadata(&options.paths.webdav_site)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(
            fs::metadata(&options.paths.dlna_config)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        let webdav = fs::read_to_string(&options.paths.webdav_site)
            .await
            .unwrap();
        assert!(webdav.contains("PidFile /run/cyberos-webdav/apache2.pid"));
        assert!(webdav.contains("ErrorLog /run/cyberos-webdav/error.log"));
        assert!(webdav.contains("DavLockDB /run/cyberos-webdav/DavLock"));
        assert!(webdav.contains("LoadModule dav_fs_module"));
        let nfs = fs::read_to_string(&options.paths.nfs_exports)
            .await
            .unwrap();
        assert!(nfs.contains("192.168.1.0/24(ro,sync,subtree_check,root_squash)"));
        let dlna = fs::read_to_string(&options.paths.dlna_config)
            .await
            .unwrap();
        assert!(dlna.contains("media_dir=A,"));
        assert!(dlna.contains("network_interface=eth0"));
        let calls = runner.calls.lock().unwrap();
        let (_, _, Some(input)) = calls
            .iter()
            .find(|(command, args, _)| {
                command == "node" && args.get(1).is_some_and(|action| action == "prepare")
            })
            .unwrap()
        else {
            panic!("share ACL prepare was not called");
        };
        let grants: Value = serde_json::from_slice(input).unwrap();
        let grants = grants["grants"].as_array().unwrap();
        assert!(
            grants
                .iter()
                .any(|grant| grant["principal"] == "cyberos_share"
                    && grant["access"] == "write"
                    && grant["scope"] == "tree")
        );
        assert!(
            grants
                .iter()
                .any(|grant| grant["principal"] == "www-data" && grant["access"] == "read")
        );
        assert!(
            grants
                .iter()
                .any(|grant| grant["principal"] == "minidlna" && grant["access"] == "read")
        );
        assert!(!grants.iter().any(|grant| {
            grant["path"]
                .as_str()
                .is_some_and(|path| path.ends_with("/other"))
        }));
        assert!(
            calls.iter().any(|(command, args, _)| command == "systemctl"
                && args == &["restart", "vsftpd.service"])
        );
    }

    #[tokio::test]
    async fn restarts_ftp_again_after_a_later_service_fails() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let request = fixture(&temp.path().join("data"));
        let options = test_options(&temp);
        let runner = FakeRunner {
            fail_service: Some("nfs-server.service".to_owned()),
            ..FakeRunner::default()
        };
        assert!(
            apply_with_options(&request, &runner, &options, &request.data_root)
                .await
                .is_err()
        );
        let calls = runner.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(command, args, _)| command == "systemctl"
                    && args == &["restart", "vsftpd.service"])
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn restores_files_when_a_reload_fails() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let request = fixture(&temp.path().join("data"));
        let options = test_options(&temp);
        if let Some(parent) = options.paths.samba_config.parent() {
            fs::create_dir_all(parent).await.unwrap();
        }
        fs::write(&options.paths.samba_config, "original\n")
            .await
            .unwrap();
        let runner = FakeRunner {
            fail_service: Some("cyberos-webdav.service".to_owned()),
            ..FakeRunner::default()
        };
        assert!(
            apply_with_options(&request, &runner, &options, &request.data_root)
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(&options.paths.samba_config)
                .await
                .unwrap(),
            "original\n"
        );
        assert!(!options.paths.webdav_site.exists());
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, args, _)| command == "node"
            && args.get(1).is_some_and(|action| action == "rollback")));
        assert_eq!(
            calls
                .iter()
                .filter(|(command, args, _)| {
                    command == "systemctl" && args == &["reload-or-restart", "smbd.service"]
                })
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn restores_the_previous_webdav_mode_after_a_failed_apply() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let request = fixture(&temp.path().join("data"));
        let options = test_options(&temp);
        fs::create_dir_all(options.paths.webdav_site.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.paths.webdav_site, "previous\n")
            .await
            .unwrap();
        fs::set_permissions(
            &options.paths.webdav_site,
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        let runner = FakeRunner {
            fail_service: Some("cyberos-webdav.service".to_owned()),
            ..FakeRunner::default()
        };

        assert!(
            apply_with_options(&request, &runner, &options, &request.data_root)
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(&options.paths.webdav_site)
                .await
                .unwrap(),
            "previous\n"
        );
        assert_eq!(
            fs::metadata(&options.paths.webdav_site)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn serves_multiple_webdav_paths_on_a_single_port() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join("data");
        fs::create_dir_all(data_root.join("pool-1/media"))
            .await
            .unwrap();
        fs::create_dir_all(data_root.join("pool-1/second"))
            .await
            .unwrap();
        let mut request = fixture(&data_root);
        let mut second = request.settings.shares[0].clone();
        second.id = "second".to_owned();
        second.path = "second".into();
        second.protocols.webdav.path_prefix = "/shares/second".to_owned();
        request.settings.shares.push(second);
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        let webdav = render_webdav(
            &request.settings,
            &resolved,
            Path::new("/cyberos/state/shares/htpasswd"),
        )
        .unwrap();

        assert_eq!(webdav.matches("Listen 8088").count(), 1);
        assert_eq!(webdav.matches("<VirtualHost *:8088>").count(), 1);
        assert!(webdav.contains("Alias \"/shares/media\""));
        assert!(webdav.contains("Alias \"/shares/second\""));
        request.settings.shares[0].protocols.webdav.allow_guest = true;
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        assert!(
            render_webdav(
                &request.settings,
                &resolved,
                Path::new("/cyberos/state/shares/htpasswd")
            )
            .unwrap()
            .contains("Require all granted")
        );
    }

    #[tokio::test]
    async fn grants_ftp_guest_access_only_when_enabled_and_respects_read_only() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join("data");
        fs::create_dir_all(data_root.join("pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&data_root);
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        let ftp = render_ftp(
            &request.settings,
            &resolved,
            Path::new("/etc/pam.d/vsftpd-cyberos"),
        )
        .unwrap();
        assert!(ftp.contains("anonymous_enable=NO"));
        assert!(
            !acl::grants_for(&request.settings, &resolved)
                .unwrap()
                .iter()
                .any(|grant| grant.principal == "ftp")
        );

        request.settings.shares[0].protocols.ftp.allow_guest = true;
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        let ftp = render_ftp(
            &request.settings,
            &resolved,
            Path::new("/etc/pam.d/vsftpd-cyberos"),
        )
        .unwrap();
        assert!(ftp.contains("anonymous_enable=YES"));
        assert!(ftp.contains("anon_upload_enable=NO"));
        assert!(
            acl::grants_for(&request.settings, &resolved)
                .unwrap()
                .iter()
                .any(|grant| grant.principal == "ftp" && grant.access == "read")
        );

        request.settings.shares[0].protocols.ftp.read_only = false;
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        let ftp = render_ftp(
            &request.settings,
            &resolved,
            Path::new("/etc/pam.d/vsftpd-cyberos"),
        )
        .unwrap();
        assert!(ftp.contains("anon_upload_enable=YES"));
        assert!(
            acl::grants_for(&request.settings, &resolved)
                .unwrap()
                .iter()
                .any(|grant| grant.principal == "ftp" && grant.access == "write")
        );
    }

    #[tokio::test]
    async fn refreshes_running_services_when_a_protocol_is_disabled() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&temp.path().join("data"));
        request.settings.shares[0].protocols.ftp.enabled = false;
        let options = test_options(&temp);
        let runner = FakeRunner::default();

        let result = apply_with_options(&request, &runner, &options, &request.data_root)
            .await
            .unwrap();

        assert!(!result.services.contains(&"vsftpd.service".to_owned()));
        assert!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(command, args, _)| {
                    command == "systemctl" && args == &["stop", "vsftpd.service"]
                })
        );
    }

    #[tokio::test]
    async fn global_disable_stops_cyberos_owned_protocol_services() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&temp.path().join("data"));
        request.settings.enabled = false;
        let runner = FakeRunner::default();

        let result =
            apply_with_options(&request, &runner, &test_options(&temp), &request.data_root)
                .await
                .unwrap();

        assert!(result.services.is_empty());
        let calls = runner.calls.lock().unwrap();
        for service in [
            "cyberos-webdav.service",
            "vsftpd.service",
            "minidlna.service",
        ] {
            assert!(
                calls
                    .iter()
                    .any(|(command, args, _)| command == "systemctl" && args == &["stop", service])
            );
            assert!(
                !calls.iter().any(|(command, args, _)| command == "systemctl"
                    && args == &["reload-or-restart", service])
            );
        }
        assert!(calls.iter().any(|(command, args, _)| command == "systemctl"
            && args == &["try-reload-or-restart", "nfs-server.service"]));
    }

    #[tokio::test]
    async fn rejects_writable_nfs_without_root_squashing() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&temp.path().join("data"));
        request.settings.shares[0].protocols.nfs.read_only = false;
        request.settings.shares[0].protocols.nfs.root_squash = false;
        let runner = FakeRunner::default();
        assert!(
            apply_with_options(&request, &runner, &test_options(&temp), &request.data_root)
                .await
                .is_err()
        );
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn maps_writable_nfs_clients_to_a_restricted_identity() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&temp.path().join("data"));
        request.settings.shares[0].protocols.nfs.read_only = false;
        let resolved = validation::resolve_shares(&request.settings, &request.data_root)
            .await
            .unwrap();
        let exports =
            render::render_nfs_with_identity(&request.settings, &resolved, Some((801, 802)))
                .unwrap();
        assert!(
            exports
                .contains("rw,sync,subtree_check,root_squash,all_squash,anonuid=801,anongid=802")
        );
    }

    #[tokio::test]
    async fn keeps_credentials_out_of_command_arguments() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("data/pool-1/media"))
            .await
            .unwrap();
        let mut request = fixture(&temp.path().join("data"));
        request.settings.account.password = Some("top-secret".to_owned());
        let options = test_options(&temp);
        fs::create_dir_all(options.paths.htpasswd.parent().unwrap())
            .await
            .unwrap();
        fs::write(&options.paths.htpasswd, "fixture\n")
            .await
            .unwrap();
        let runner = FakeRunner::default();
        apply_with_options(&request, &runner, &options, &request.data_root)
            .await
            .unwrap();
        let calls = runner.calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .all(|(_, args, _)| !args.iter().any(|arg| arg.contains("top-secret")))
        );
        assert!(calls.iter().any(|(command, _, input)| {
            command == "smbpasswd"
                && input
                    .as_deref()
                    .is_some_and(|input| input.windows(10).any(|part| part == b"top-secret"))
        }));
    }

    #[tokio::test]
    async fn creates_a_share_login_with_an_existing_private_home_path() {
        let temp = TempDir::new().unwrap();
        let mut request = fixture(temp.path());
        request.settings.account.password = Some("fixture-secret".to_owned());
        let runner = FakeRunner {
            missing_user: true,
            ..FakeRunner::default()
        };
        credentials::apply_credentials(
            &request.settings,
            &test_options(&temp).paths,
            &runner,
            "cyberos",
        )
        .await
        .unwrap();
        let calls = runner.calls.lock().unwrap();
        assert!(calls.iter().any(|(command, args, _)| {
            command == "useradd"
                && args
                    .windows(2)
                    .any(|pair| pair == ["--home-dir", "/cyberos/home/share"])
        }));
    }

    #[tokio::test]
    async fn rejects_share_paths_that_escape_the_storage_pool() {
        let mut request = fixture(Path::new("/cyberos/data"));
        request.settings.shares[0].path = "../../etc".into();
        assert!(
            resolve_shares(&request.settings, &request.data_root)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_share_paths_that_resolve_outside_the_storage_pool() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join("data");
        let storage_pool = data_root.join("pool-1");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&storage_pool).await.unwrap();
        fs::create_dir_all(&outside).await.unwrap();
        std::os::unix::fs::symlink(&outside, storage_pool.join("escape")).unwrap();
        let mut request = fixture(&data_root);
        request.settings.shares[0].path = "escape".into();

        assert!(
            resolve_shares(&request.settings, &request.data_root)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_share_paths_that_cannot_be_embedded_in_service_configs() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join("data");
        fs::create_dir_all(data_root.join("pool-1/media\ninclude = /tmp/override"))
            .await
            .unwrap();
        let mut request = fixture(&data_root);
        request.settings.shares[0].path = PathBuf::from("media\ninclude = /tmp/override");
        let runner = FakeRunner::default();

        let error = apply_with_options(&request, &runner, &test_options(&temp), &request.data_root)
            .await
            .unwrap_err();

        assert_eq!(error.code, crate::error::ErrorCode::Validation);
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_nfs_export_injection_in_allowed_cidrs() {
        let mut request = fixture(Path::new("/cyberos/data"));
        request.settings.shares[0].protocols.nfs.allowed_cidrs =
            vec!["*(rw,no_root_squash) 0.0.0.0/0".to_owned()];

        assert_eq!(
            validate_request(&request).unwrap_err().code,
            crate::error::ErrorCode::Validation
        );
    }

    #[test]
    fn rejects_client_data_root_that_does_not_match_hostd_configuration() {
        let request = fixture(Path::new("/"));

        assert_eq!(
            validate_requested_data_root(&request.data_root, Path::new("/cyberos/data"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Validation
        );
    }
}
