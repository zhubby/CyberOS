use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_hostd::config::HostdConfig;
use zos_hostd::error::{ErrorCode, HostdError};
use zos_hostd::server::HostdServer;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let result = run().await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(code = ?error.code, message = %error.message, "hostd stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), HostdError> {
    if std::env::args_os().nth(1).is_some() {
        return Err(HostdError::new(
            400,
            ErrorCode::Validation,
            "usage: zos-hostd",
        ));
    }
    let config = HostdConfig::load()?;
    HostdServer::new(config).run().await
}
