#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TransferError(pub String);

impl From<std::io::Error> for TransferError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<rusqlite::Error> for TransferError {
    fn from(error: rusqlite::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<zbus::Error> for TransferError {
    fn from(error: zbus::Error) -> Self {
        Self(error.to_string())
    }
}
