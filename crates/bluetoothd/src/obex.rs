use std::collections::HashMap;
use std::time::Duration;

use zbus::{Connection, ObjectPath, OwnedObjectPath, OwnedVariant, Proxy, Variant, interface};

use crate::db::{Db, ReceiveRecord, SendTask};
use crate::error::TransferError;
use crate::safety::{
    ensure_available_space, open_send_file, unique_receive_target, validate_storage_pool,
};

const OBEX: &str = "org.bluez.obex";
const AGENT_PATH: &str = "/org/zos/BluetoothObexAgent";

pub struct ObexRuntime {
    session: Connection,
    system: Connection,
}

impl ObexRuntime {
    pub async fn initialize(db: Db) -> Result<Self, TransferError> {
        let session = Connection::session().await?;
        let system = Connection::system().await?;
        session
            .object_server()
            .at(
                AGENT_PATH,
                ObexAgent {
                    db,
                    session: session.clone(),
                    system: system.clone(),
                },
            )
            .await?;
        let manager = Proxy::new(
            &session,
            OBEX,
            "/org/bluez/obex",
            "org.bluez.obex.AgentManager1",
        )
        .await?;
        let path =
            ObjectPath::try_from(AGENT_PATH).map_err(|error| TransferError(error.to_string()))?;
        manager.call::<_, _, ()>("RegisterAgent", &(path,)).await?;
        Ok(Self { session, system })
    }

    pub async fn send(&self, db: &Db, task: &SendTask) -> Result<(), TransferError> {
        let (_file, path) = open_send_file(&task.root_path, &task.relative_path)?;
        validate_storage_pool(&task.root_path, &task.storage_pool_id, &path)?;
        let client = Proxy::new(
            &self.session,
            OBEX,
            "/org/bluez/obex",
            "org.bluez.obex.Client1",
        )
        .await?;
        let mut args: HashMap<&str, Variant<'_>> = HashMap::new();
        args.insert("Target", Variant::from("opp"));
        args.insert(
            "Source",
            Variant::from(adapter_address(&self.system, &task.adapter_id).await?),
        );
        let session: OwnedObjectPath = client
            .call("CreateSession", &(task.device_address.as_str(), args))
            .await?;
        let push = Proxy::new(
            &self.session,
            OBEX,
            session.as_str(),
            "org.bluez.obex.ObjectPush1",
        )
        .await?;
        let (transfer, _properties): (OwnedObjectPath, HashMap<String, OwnedVariant>) = push
            .call("SendFile", &(path.to_string_lossy().to_string(),))
            .await?;
        let result = self.monitor_transfer(db, &task.id, &transfer).await;
        let _ = client.call::<_, _, ()>("RemoveSession", &(session,)).await;
        result
    }

    async fn monitor_transfer(
        &self,
        db: &Db,
        id: &str,
        transfer: &OwnedObjectPath,
    ) -> Result<(), TransferError> {
        let proxy = Proxy::new(
            &self.session,
            OBEX,
            transfer.as_str(),
            "org.bluez.obex.Transfer1",
        )
        .await?;
        loop {
            let status: String = proxy.get_property("Status").await?;
            let transferred: u64 = proxy.get_property("Transferred").await.unwrap_or(0);
            let size: u64 = proxy.get_property("Size").await.unwrap_or(0);
            if db.cancel_requested(id)? {
                let _ = proxy.call::<_, _, ()>("Cancel", &()).await;
                return Err(TransferError("Bluetooth transfer was cancelled".to_owned()));
            }
            if !db.update_progress(
                id,
                transferred,
                (size > 0).then_some(size),
                Some(transfer.as_str()),
            )? {
                return Err(TransferError(
                    "Bluetooth transfer is no longer active".to_owned(),
                ));
            }
            match status.as_str() {
                "complete" => return Ok(()),
                "error" => {
                    return Err(TransferError(
                        "BlueZ OBEX reported a transfer failure".to_owned(),
                    ));
                }
                _ => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }
    }
}

struct ObexAgent {
    db: Db,
    session: Connection,
    system: Connection,
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.obex.Error")]
enum AgentError {
    Rejected(String),
}

#[interface(name = "org.bluez.obex.Agent1")]
impl ObexAgent {
    async fn release(&self) {}

    async fn authorize_push(&self, transfer: ObjectPath<'_>) -> Result<String, AgentError> {
        self.authorize_push_inner(&transfer)
            .await
            .map_err(|error| AgentError::Rejected(error.0))
    }

    async fn cancel(&self) {}
}

impl ObexAgent {
    async fn authorize_push_inner(
        &self,
        transfer: &ObjectPath<'_>,
    ) -> Result<String, TransferError> {
        let settings = self.db.settings()?;
        if !settings.receive_enabled {
            return Err(TransferError("Bluetooth receiving is disabled".to_owned()));
        }
        let (root_id, pool_id, inbox) = match (
            settings.inbox_root_id.as_deref(),
            settings.inbox_storage_pool_id.as_deref(),
            settings.inbox_path.as_deref(),
        ) {
            (Some(root), Some(pool), Some(path)) => (root, pool, path),
            _ => {
                return Err(TransferError(
                    "Bluetooth inbox is not configured".to_owned(),
                ));
            }
        };
        let transfer_proxy = Proxy::new(
            &self.session,
            OBEX,
            transfer.as_str(),
            "org.bluez.obex.Transfer1",
        )
        .await?;
        let name: String = transfer_proxy.get_property("Name").await?;
        let size: u64 = transfer_proxy.get_property("Size").await.unwrap_or(0);
        let session_path: OwnedObjectPath = transfer_proxy.get_property("Session").await?;
        let session_proxy = Proxy::new(
            &self.session,
            OBEX,
            session_path.as_str(),
            "org.bluez.obex.Session1",
        )
        .await?;
        let address: String = session_proxy.get_property("Destination").await?;
        if !trusted_device(&self.system, &address).await? {
            return Err(TransferError(
                "Only trusted paired devices may send files".to_owned(),
            ));
        }
        let root_path = self.db.root_path(root_id)?;
        let inbox_path = crate::safety::safe_existing(&root_path, inbox)?;
        validate_storage_pool(&root_path, pool_id, &inbox_path)?;
        ensure_available_space(&inbox_path, size)?;
        let target = unique_receive_target(&root_path, inbox, &name)?;
        let relative = target
            .strip_prefix(&root_path)
            .map_err(|_| TransferError("Bluetooth inbox escaped the NAS root".to_owned()))?
            .to_string_lossy()
            .to_string();
        let id = self.db.record_receive(ReceiveRecord {
            address: &address,
            root_id,
            pool_id,
            relative_path: &relative,
            display_name: target
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&name),
            total_bytes: (size > 0).then_some(size),
        })?;
        let target_name = target.to_string_lossy().to_string();
        monitor_incoming(
            self.db.clone(),
            self.session.clone(),
            id,
            transfer.to_owned().into(),
            target,
        );
        Ok(target_name)
    }
}

async fn adapter_address(system: &Connection, adapter_id: &str) -> Result<String, TransferError> {
    let expected_path = adapter_object_path(adapter_id)?;
    let objects = managed_objects(system).await?;
    objects
        .iter()
        .find(|(path, interfaces)| {
            path.as_str() == expected_path && interfaces.contains_key("org.bluez.Adapter1")
        })
        .and_then(|(_, interfaces)| interfaces.get("org.bluez.Adapter1"))
        .and_then(|properties| properties.get("Address"))
        .and_then(|value| value.downcast_ref::<String>().ok())
        .ok_or_else(|| TransferError("Bluetooth adapter was not found".to_owned()))
}

fn adapter_object_path(adapter_id: &str) -> Result<String, TransferError> {
    let adapter_name = adapter_id
        .strip_prefix("adapter-")
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
        })
        .ok_or_else(|| TransferError("Invalid Bluetooth adapter id".to_owned()))?;
    Ok(format!("/org/bluez/{adapter_name}"))
}

async fn trusted_device(system: &Connection, address: &str) -> Result<bool, TransferError> {
    let objects = managed_objects(system).await?;
    for interfaces in objects.values() {
        let Some(properties) = interfaces.get("org.bluez.Device1") else {
            continue;
        };
        let candidate = properties
            .get("Address")
            .and_then(|value| value.downcast_ref::<String>().ok());
        let paired = properties
            .get("Paired")
            .and_then(|value| value.downcast_ref::<bool>().ok())
            .unwrap_or(false);
        let trusted = properties
            .get("Trusted")
            .and_then(|value| value.downcast_ref::<bool>().ok())
            .unwrap_or(false);
        if candidate
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(address))
        {
            return Ok(paired && trusted);
        }
    }
    Ok(false)
}

type ManagedObjects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedVariant>>>;

async fn managed_objects(system: &Connection) -> Result<ManagedObjects, TransferError> {
    let manager = Proxy::new(
        system,
        "org.bluez",
        "/",
        "org.freedesktop.DBus.ObjectManager",
    )
    .await?;
    Ok(manager.call("GetManagedObjects", &()).await?)
}

fn monitor_incoming(
    db: Db,
    session: Connection,
    id: String,
    transfer: OwnedObjectPath,
    target: std::path::PathBuf,
) {
    tokio::spawn(async move {
        let result = async {
            let proxy = Proxy::new(
                &session,
                OBEX,
                transfer.as_str(),
                "org.bluez.obex.Transfer1",
            )
            .await?;
            loop {
                if db.cancel_requested(&id)? {
                    let _ = proxy.call::<_, _, ()>("Cancel", &()).await;
                    return Err(TransferError("Bluetooth transfer was cancelled".to_owned()));
                }
                let status: String = proxy.get_property("Status").await?;
                let transferred: u64 = proxy.get_property("Transferred").await.unwrap_or(0);
                let size: u64 = proxy.get_property("Size").await.unwrap_or(0);
                if !db.update_progress(
                    &id,
                    transferred,
                    (size > 0).then_some(size),
                    Some(transfer.as_str()),
                )? {
                    return Err(TransferError(
                        "Bluetooth transfer is no longer active".to_owned(),
                    ));
                }
                match status.as_str() {
                    "complete" => return Ok::<(), TransferError>(()),
                    "error" => {
                        return Err(TransferError(
                            "BlueZ OBEX reported a receive failure".to_owned(),
                        ));
                    }
                    _ => tokio::time::sleep(Duration::from_millis(500)).await,
                }
            }
        }
        .await;
        match result {
            Ok(()) => {
                let _ = db.finish(&id, "completed", None);
            }
            Err(_error) if db.cancel_requested(&id).unwrap_or(false) => {
                let _ = db.finish(&id, "cancelled", None);
                let _ = std::fs::remove_file(&target);
            }
            Err(error) => {
                let _ = db.finish(&id, "failed", Some(&error.0));
                let _ = std::fs::remove_file(&target);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::adapter_object_path;

    #[test]
    fn adapter_ids_resolve_only_to_bluez_adapter_paths() {
        assert_eq!(
            adapter_object_path("adapter-hci0").unwrap(),
            "/org/bluez/hci0"
        );
        assert!(adapter_object_path("hci0").is_err());
        assert!(adapter_object_path("adapter-../../hci0").is_err());
    }
}
