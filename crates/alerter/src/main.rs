use std::process::ExitCode;

use cyberos_alerter::{AlerterConfig, AlerterService};
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
            tracing::error!(error = %error, "alerter stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), cyberos_alerter::error::AlerterError> {
    let service = AlerterService::new(AlerterConfig::load()?);
    cyberos_alerter::runtime::signals::install(service.shutdown_token());
    service.run().await
}
