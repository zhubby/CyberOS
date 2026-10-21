use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_vod_player::config::VodPlayerConfig;
use zos_vod_player::error::{ErrorCode, VodError};
use zos_vod_player::server::VodPlayerServer;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(code = ?error.code, message = %error.message, "VOD player stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), VodError> {
    if std::env::args_os().nth(1).is_some() {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "usage: zos-vod-player",
            400,
        ));
    }
    let config = VodPlayerConfig::load()?;
    if !config.enabled {
        tracing::info!("VOD player is disabled");
        return Ok(());
    }
    VodPlayerServer::new(config).await?.run().await
}
