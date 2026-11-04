mod ble_output;
mod bluez;
mod output;
mod playback;
mod protocol;
mod server;

#[cfg(test)]
mod protocol_tests;

#[cfg(test)]
mod playback_tests;

// Forking a converter can briefly retain another test's socket before exec.
#[cfg(test)]
static PROCESS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
