use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_termux::config::TermuxConfig;
use zos_termux::error::{ErrorCode, TermuxError};
use zos_termux::server::TermuxServer;

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
            tracing::error!(code = ?error.code, message = %error.message, "termux stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), TermuxError> {
    if std::env::args_os().nth(1).is_some() {
        return Err(TermuxError::new(
            400,
            ErrorCode::Validation,
            "usage: zos-termux",
        ));
    }
    TermuxServer::new(TermuxConfig::load()?).run().await
}
