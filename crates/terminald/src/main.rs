use std::process::ExitCode;

use cyberos_terminald::config::TerminalConfig;
use cyberos_terminald::error::{ErrorCode, TerminalError};
use cyberos_terminald::server::TerminalServer;
use tracing_subscriber::EnvFilter;

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
            tracing::error!(code = ?error.code, message = %error.message, "terminal stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), TerminalError> {
    if std::env::args_os().nth(1).is_some() {
        return Err(TerminalError::new(
            400,
            ErrorCode::Validation,
            "usage: cyberos-terminald",
        ));
    }
    TerminalServer::new(TerminalConfig::load()?).run().await
}
