use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_bluetoothd::BluetoothTransferService;
use zos_bluetoothd::config::Config;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
    let result = async {
        let config = Config::load()?;
        BluetoothTransferService::new(&config).await?.run().await
    }
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(message = %error, "Bluetooth transfer service stopped");
            ExitCode::FAILURE
        }
    }
}
