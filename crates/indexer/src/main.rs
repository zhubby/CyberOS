use std::process::ExitCode;

use cyberos_indexer::config::Config;
use cyberos_indexer::error::{ErrorCode, IndexerError};
use cyberos_indexer::{Indexer, OnceOptions};
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
            tracing::error!(code = error.code.as_str(), message = %error.message, "Indexer stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), IndexerError> {
    let mode = parse_arguments(std::env::args().skip(1))?;
    let RunMode::Run(once) = mode else {
        return Ok(());
    };
    let indexer = Indexer::new(Config::load()?)?;
    let shutdown = indexer.shutdown_token();
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
    indexer.run(once).await
}

#[derive(Debug, PartialEq, Eq)]
enum RunMode {
    Help,
    Run(Option<OnceOptions>),
}

fn parse_arguments(arguments: impl IntoIterator<Item = String>) -> Result<RunMode, IndexerError> {
    let mut once = false;
    let mut options = OnceOptions::default();
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--once" => once = true,
            "--recursive" => options.recursive = true,
            "--storage-pool" => {
                options.storage_pool_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| invalid_argument("--storage-pool requires a value"))?,
                )
            }
            "--path" => {
                options.path = Some(
                    arguments
                        .next()
                        .ok_or_else(|| invalid_argument("--path requires a value"))?,
                )
            }
            "--help" | "-h" => {
                println!(
                    "Usage: cyberos-indexer [--once [--storage-pool STORAGE_POOL_ID] [--path PATH] [--recursive]]"
                );
                return Ok(RunMode::Help);
            }
            _ => return Err(invalid_argument(format!("Unknown argument: {argument}"))),
        }
    }
    if !once && (options.storage_pool_id.is_some() || options.path.is_some() || options.recursive) {
        return Err(invalid_argument(
            "--storage-pool, --path and --recursive require --once",
        ));
    }
    Ok(RunMode::Run(once.then_some(options)))
}

fn invalid_argument(message: impl Into<String>) -> IndexerError {
    IndexerError::new(ErrorCode::InvalidPath, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_exits_without_starting_the_daemon() {
        assert_eq!(
            parse_arguments(["--help".to_owned()]).unwrap(),
            RunMode::Help
        );
    }

    #[test]
    fn once_arguments_are_parsed_together() {
        let mode = parse_arguments([
            "--once".to_owned(),
            "--storage-pool".to_owned(),
            "local".to_owned(),
            "--path".to_owned(),
            "docs".to_owned(),
            "--recursive".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            mode,
            RunMode::Run(Some(OnceOptions {
                storage_pool_id: Some("local".to_owned()),
                path: Some("docs".to_owned()),
                recursive: true,
            }))
        );
    }
}
