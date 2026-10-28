use std::process::ExitCode;

use cyberos_photos::Photos;
use cyberos_photos::config::Config;
use cyberos_photos::error::PhotosError;
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
            tracing::error!(code = error.code.as_str(), message = %error.message, "Photos stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), PhotosError> {
    let worker = Photos::new(Config::load()?)?;
    let shutdown = worker.shutdown_token();
    tokio::spawn(async move {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("SIGINT handler");
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        shutdown.cancel();
    });
    worker.run().await
}
