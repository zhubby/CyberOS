mod bluez;
mod output;
mod protocol;
mod server;

#[cfg(test)]
mod protocol_tests;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .init();
    match server::run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "Audio daemon stopped");
            std::process::ExitCode::FAILURE
        }
    }
}
