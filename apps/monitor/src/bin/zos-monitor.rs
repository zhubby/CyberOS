use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_monitor::{Config, MonitorService};

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
            tracing::error!(error = %error, "monitor stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), zos_monitor::error::MonitorError> {
    let service = MonitorService::new(Config::load()?);
    zos_monitor::runtime::signals::install(service.shutdown_token());
    service.run().await
}
