use std::process::ExitCode;

use tracing_subscriber::EnvFilter;
use zos_downloader::Downloader;
use zos_downloader::config::Config;

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
            tracing::error!(code = error.code.as_str(), message = %error.message, "downloader stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), zos_downloader::error::DownloadError> {
    let config = Config::load()?;
    let downloader = Downloader::new(&config)?;
    let shutdown = downloader.shutdown_token();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
            let mut interrupt = signal(SignalKind::interrupt()).expect("SIGINT handler");
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await.expect("Ctrl-C handler");
        shutdown.cancel();
    });
    downloader.run().await
}
