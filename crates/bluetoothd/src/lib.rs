pub mod config;
mod db;
pub mod error;
mod obex;
mod safety;

use std::time::Duration;

use config::Config;
use db::Db;
use error::TransferError;
use obex::ObexRuntime;

pub struct BluetoothTransferService {
    db: Db,
    obex: ObexRuntime,
}

impl BluetoothTransferService {
    pub async fn new(config: &Config) -> Result<Self, TransferError> {
        std::fs::create_dir_all(&config.incoming_path)?;
        let db = Db::open(&config.database_path)?;
        db.recover_interrupted(&config.incoming_path)?;
        let obex = ObexRuntime::initialize(
            db.clone(),
            config.data_root.clone(),
            config.incoming_path.clone(),
            config.production,
        )
        .await?;
        Ok(Self { db, obex })
    }

    pub async fn run(&self) -> Result<(), TransferError> {
        loop {
            self.db.heartbeat(None)?;
            if let Some(task) = self.db.claim_send()? {
                let result = self.obex.send(&self.db, &task).await;
                match result {
                    Ok(()) => self.db.finish(&task.id, "completed", None)?,
                    Err(_error) if self.db.cancel_requested(&task.id).unwrap_or(false) => {
                        self.db.finish(&task.id, "cancelled", None)?;
                    }
                    Err(error) => {
                        tracing::warn!(transfer_id = %task.id, message = %error.0, "Bluetooth send failed");
                        self.db.finish(&task.id, "failed", Some(&error.0))?;
                    }
                }
            } else {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
