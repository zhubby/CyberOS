use super::*;
use crate::command::CommandOutput;
use async_trait::async_trait;
use std::sync::Mutex;
use tempfile::TempDir;

struct FakeApi {
    prefs: Mutex<Value>,
    native: Mutex<Value>,
    writes: Mutex<Vec<(String, Value)>>,
    reject_patch: Mutex<bool>,
}
impl FakeApi {
    fn new() -> Self {
        Self {
            prefs: Mutex::new(
                json!({"ControlURL":OFFICIAL_CONTROL,"WantRunning":true,"Hostname":"nas","CorpDNS":true,"RouteAll":false,"ExitNodeID":"","ExitNodeIP":"","ExitNodeAllowLANAccess":false,"AdvertiseRoutes":null,"RunSSH":true,"AdvertiseTags":["tag:nas"],"Config":{"PrivateNodeKey":"private-node-key-do-not-return","PrivateMachineKey":"machine-key"}}),
            ),
            native: Mutex::new(
                json!({"Version":"1.102.4","HaveNodeKey":true,"BackendState":"Running","TailscaleIPs":["100.64.0.1","fd7a:115c:a1e0::1"],"Self":{"ID":"nSelf","HostName":"NAS","DNSName":"nas.example.ts.net.","UserID":1,"KeyExpiry":"2027-01-01T00:00:00Z"},"User":{"1":{"LoginName":"owner@example.com"}},"CurrentTailnet":{"Name":"example.ts.net"},"Peer":{"key":{"ID":"nExit","HostName":"exit","OS":"linux","TailscaleIPs":["100.64.0.2"],"Online":true,"ExitNodeOption":true,"CurAddr":"192.0.2.2:41641"}},"Health":[]}),
            ),
            writes: Mutex::new(Vec::new()),
            reject_patch: Mutex::new(false),
        }
    }
}
#[async_trait]
impl LocalApi for FakeApi {
    async fn request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, HostdError> {
        if method == "GET" {
            return Ok(if endpoint == "prefs" {
                self.prefs.lock().unwrap().clone()
            } else {
                self.native.lock().unwrap().clone()
            });
        }
        let body = body.unwrap_or(Value::Null);
        if method == "PATCH" {
            if *self.reject_patch.lock().unwrap() {
                return Err(HostdError::operation_failed(
                    "Tailscale rejected configuration",
                ));
            }
            let mut prefs = self.prefs.lock().unwrap();
            for (key, value) in body.as_object().unwrap() {
                if !key.ends_with("Set") {
                    assert_eq!(
                        body[format!("{key}Set")],
                        true,
                        "every update must be masked"
                    );
                    prefs[key] = value.clone();
                }
            }
        }
        self.writes.lock().unwrap().push((endpoint.into(), body));
        Ok(Value::Null)
    }
}

#[derive(Default)]
struct FakeRunner {
    calls: Mutex<Vec<Vec<String>>>,
}
#[async_trait]
impl CommandRunner for FakeRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        _input: Option<&[u8]>,
        _timeout: Duration,
        _limit: usize,
    ) -> Result<CommandOutput, HostdError> {
        assert_eq!(command, "systemctl");
        self.calls.lock().unwrap().push(args.to_vec());
        Ok(CommandOutput {
            stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n".into(),
            stderr: String::new(),
            success: true,
        })
    }
}

fn options(root: &TempDir) -> Options {
    Options {
        socket: root.path().join("tailscaled.sock"),
        state_dir: root.path().join("state"),
        forwarding_config: root.path().join("forwarding.conf"),
        proc_sys: root.path().join("proc"),
    }
}
async fn apply_settings(
    api: &FakeApi,
    runner: &FakeRunner,
    options: &Options,
    settings: Value,
) -> Result<Status, HostdError> {
    let current = status(runner, api, options).await?;
    let request = serde_json::from_value(json!({"action":"settings","input":{"settings":settings,"expectedRevision":current.revision,"confirmed":true}})).unwrap();
    execute(request, runner, api, options).await
}

#[tokio::test]
async fn returns_public_state_without_private_keys_and_preserves_unknown_native_fields() {
    let root = TempDir::new().unwrap();
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let value = status(&runner, &api, &options(&root)).await.unwrap();
    assert_eq!(value.account.as_deref(), Some("owner@example.com"));
    assert_eq!(value.peers[0].id, "nExit");
    assert!(value.service.auto_start);
    let output = serde_json::to_string(&value).unwrap();
    assert!(!output.contains("private-node-key"));
    assert!(!output.contains("PrivateMachineKey"));
    assert!(!output.contains("Config"));
    assert_eq!(value.exit_node_approved, None);
    let applied = apply_settings(&api, &runner, &options(&root), json!({"acceptDns":false}))
        .await
        .unwrap();
    assert!(!applied.settings.accept_dns);
    let prefs = api.prefs.lock().unwrap();
    assert_eq!(prefs["RunSSH"], true);
    assert_eq!(prefs["AdvertiseTags"], json!(["tag:nas"]));
    assert_eq!(prefs["Config"]["PrivateMachineKey"], "machine-key");
}

#[tokio::test]
async fn requires_confirmation_and_rejects_stale_requests_before_side_effects() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let current = status(&runner, &api, &options).await.unwrap();
    for (confirmed, expected, code) in [
        (false, current.revision.clone(), 400),
        (true, "stale".into(), 409),
    ] {
        let request=serde_json::from_value(json!({"action":"action","input":{"action":"logout","expectedRevision":expected,"confirmed":confirmed}})).unwrap();
        assert_eq!(
            execute(request, &runner, &api, &options)
                .await
                .unwrap_err()
                .status,
            code
        );
    }
    assert!(api.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn restores_after_restart_and_deadline_without_reverting_external_changes() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    apply_settings(
        &api,
        &runner,
        &options,
        json!({"acceptDns":false,"hostname":"new-name"}),
    )
    .await
    .unwrap();
    api.prefs.lock().unwrap()["Hostname"] = json!("external-name");
    let result = transaction::recover_expired(
        &api,
        &runner,
        &options,
        OffsetDateTime::now_utc() + time::Duration::seconds(61),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(api.prefs.lock().unwrap()["CorpDNS"], true);
    assert_eq!(api.prefs.lock().unwrap()["Hostname"], "external-name");
    assert_eq!(
        transaction::read(&options)
            .await
            .unwrap()
            .unwrap()
            .public
            .state,
        TransactionState::Conflict
    );
    let content = tokio::fs::read_to_string(options.state_dir.join("transaction.json"))
        .await
        .unwrap();
    assert!(!content.contains("private-node-key"));
}

#[tokio::test]
async fn refuses_old_account_rollback_and_concurrent_mutations() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let state = apply_settings(&api, &runner, &options, json!({"acceptDns":false}))
        .await
        .unwrap();
    assert_eq!(
        apply_settings(&api, &runner, &options, json!({"acceptRoutes":true}))
            .await
            .unwrap_err()
            .status,
        409
    );
    api.native.lock().unwrap()["Self"]["ID"] = json!("new-account-node");
    let tx = state.transaction.unwrap();
    assert_eq!(
        transaction::finish(&tx.id, false, &api, &runner, &options)
            .await
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(api.prefs.lock().unwrap()["CorpDNS"], false);
}

#[tokio::test]
async fn confirms_changes_and_keeps_subnet_and_exit_advertisements_together() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let state = apply_settings(
        &api,
        &runner,
        &options,
        json!({"advertisedRoutes":["192.168.10.0/24","fd00::/64"],"advertiseExitNode":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        api.prefs.lock().unwrap()["AdvertiseRoutes"],
        json!(["192.168.10.0/24", "fd00::/64", "0.0.0.0/0", "::/0"])
    );
    let tx = state.transaction.unwrap();
    transaction::finish(&tx.id, true, &api, &runner, &options)
        .await
        .unwrap();
    let state = apply_settings(&api, &runner, &options, json!({"advertiseExitNode":false}))
        .await
        .unwrap();
    assert_eq!(
        state.settings.advertised_routes,
        vec!["192.168.10.0/24", "fd00::/64"]
    );
    assert!(!state.settings.advertise_exit_node);
    assert!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|a| a == &["restart", "cyberos-tailscale-forwarding.service"])
    );
}

#[tokio::test]
async fn rejects_invalid_routes_and_conflicting_or_unapproved_exit_nodes() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    for patch in [
        json!({"advertisedRoutes":["0.0.0.0/0"]}),
        json!({"advertisedRoutes":["192.168.1.2/24"]}),
        json!({"advertisedRoutes":["::/0"]}),
        json!({"advertisedRoutes":["::/129"]}),
        json!({"exitNodeId":"attacker"}),
        json!({"exitNodeId":"nExit","advertiseExitNode":true}),
        json!({"hostname":"bad;reboot"}),
    ] {
        assert_eq!(
            apply_settings(&api, &runner, &options, patch)
                .await
                .unwrap_err()
                .status,
            400
        );
    }
    assert!(api.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn supports_browser_and_key_login_without_persisting_auth_keys() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    api.native.lock().unwrap()["BackendState"] = json!("NeedsLogin");
    api.native.lock().unwrap()["Self"]["UserID"] = Value::Null;
    api.prefs.lock().unwrap()["LoggedOut"] = json!(true);
    for (method, key) in [
        ("browser", Value::Null),
        ("auth_key", json!("tskey-auth-test-secret")),
    ] {
        let current = status(&runner, &api, &options).await.unwrap();
        let request=serde_json::from_value(json!({"action":"login","input":{"method":method,"authKey":key,"controlUrl":"https://headscale.example.com","expectedRevision":current.revision,"confirmed":true}})).unwrap();
        let state = execute(request, &runner, &api, &options).await.unwrap();
        assert_eq!(api.prefs.lock().unwrap()["LoggedOut"], false);
        assert_eq!(state.control_url, "https://headscale.example.com");
        assert!(
            !serde_json::to_string(&state)
                .unwrap()
                .contains("tskey-auth")
        );
        assert!(!options.state_dir.exists());
    }
    assert!(
        api.writes
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _)| path == "login-interactive")
    );
}

#[test]
fn validates_control_and_authorization_urls() {
    for url in [
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "https://example.com?token=abc",
        "javascript:alert(1)",
    ] {
        assert!(settings::control_url(url).is_err());
    }
    assert_eq!(
        settings::control_url("https://headscale.example.com/").unwrap(),
        "https://headscale.example.com"
    );
    assert!(settings::safe_login_url(
        "https://login.tailscale.com/a/test",
        OFFICIAL_CONTROL
    ));
    assert!(!settings::safe_login_url(
        "https://evil.example/a/test",
        OFFICIAL_CONTROL
    ));
    assert!(!settings::safe_login_url(
        "javascript:alert(1)",
        OFFICIAL_CONTROL
    ));
}

#[tokio::test]
async fn rejects_symlinked_recovery_state() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    tokio::fs::create_dir(root.path().join("external"))
        .await
        .unwrap();
    std::os::unix::fs::symlink(root.path().join("external"), &options.state_dir).unwrap();
    assert_eq!(
        apply_settings(&api, &runner, &options, json!({"acceptDns":false}))
            .await
            .unwrap_err()
            .status,
        409
    );
    assert!(api.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cannot_switch_an_active_tagged_nodes_control_server() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    api.native.lock().unwrap()["Self"]["UserID"] = Value::Null;
    let runner = FakeRunner::default();
    let current = status(&runner, &api, &options).await.unwrap();
    assert!(current.account.is_none());
    let request = serde_json::from_value(json!({"action":"login","input":{"method":"browser","authKey":null,"controlUrl":"https://headscale.example.com","expectedRevision":current.revision,"confirmed":true}})).unwrap();
    assert_eq!(
        execute(request, &runner, &api, &options)
            .await
            .unwrap_err()
            .status,
        409
    );
    assert!(api.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn persists_a_clean_rollback_when_the_daemon_rejects_settings() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    *api.reject_patch.lock().unwrap() = true;
    assert!(
        apply_settings(
            &api,
            &runner,
            &options,
            json!({"advertisedRoutes":["192.168.10.0/24"]})
        )
        .await
        .is_err()
    );
    assert!(!options.forwarding_config.exists());
    assert_eq!(
        transaction::read(&options)
            .await
            .unwrap()
            .unwrap()
            .public
            .state,
        TransactionState::RolledBack
    );
    assert!(api.prefs.lock().unwrap()["AdvertiseRoutes"].is_null());
}

#[tokio::test]
async fn rollback_restores_gateway_forwarding_after_a_reboot() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let state = apply_settings(
        &api,
        &runner,
        &options,
        json!({"advertisedRoutes":["192.168.10.0/24"]}),
    )
    .await
    .unwrap();
    transaction::finish(
        &state.transaction.unwrap().id,
        true,
        &api,
        &runner,
        &options,
    )
    .await
    .unwrap();
    let state = apply_settings(&api, &runner, &options, json!({"advertisedRoutes":[]}))
        .await
        .unwrap();
    assert!(!options.forwarding_config.exists());
    runner.calls.lock().unwrap().clear();
    transaction::finish(
        &state.transaction.unwrap().id,
        false,
        &api,
        &runner,
        &options,
    )
    .await
    .unwrap();
    assert_eq!(
        api.prefs.lock().unwrap()["AdvertiseRoutes"],
        json!(["192.168.10.0/24"])
    );
    assert!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args == &["restart", "cyberos-tailscale-forwarding.service"])
    );
}

#[tokio::test]
async fn rollback_preserves_forwarding_for_external_route_changes() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let state = apply_settings(
        &api,
        &runner,
        &options,
        json!({"advertisedRoutes":["192.168.10.0/24"]}),
    )
    .await
    .unwrap();
    let applied = tokio::fs::read_to_string(&options.forwarding_config)
        .await
        .unwrap();
    api.prefs.lock().unwrap()["AdvertiseRoutes"] = json!(["192.168.20.0/24"]);
    assert!(
        transaction::finish(
            &state.transaction.unwrap().id,
            false,
            &api,
            &runner,
            &options
        )
        .await
        .is_err()
    );
    assert_eq!(
        api.prefs.lock().unwrap()["AdvertiseRoutes"],
        json!(["192.168.20.0/24"])
    );
    assert_eq!(
        tokio::fs::read_to_string(&options.forwarding_config)
            .await
            .unwrap(),
        applied
    );
}

#[tokio::test]
async fn canonicalizes_ipv6_routes_before_recording_confirmation_values() {
    let root = TempDir::new().unwrap();
    let options = options(&root);
    let api = FakeApi::new();
    let runner = FakeRunner::default();
    let state = apply_settings(
        &api,
        &runner,
        &options,
        json!({"advertisedRoutes":["FD42:7C6E:CA17:0000::/064","fd42:7c6e:ca17::/64"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        state.settings.advertised_routes,
        vec!["fd42:7c6e:ca17::/64"]
    );
    transaction::finish(
        &state.transaction.unwrap().id,
        true,
        &api,
        &runner,
        &options,
    )
    .await
    .unwrap();
}
