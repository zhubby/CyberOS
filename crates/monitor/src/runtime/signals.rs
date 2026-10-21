use tokio_util::sync::CancellationToken;

pub fn install(shutdown: CancellationToken) {
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
}
