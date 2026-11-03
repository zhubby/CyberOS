use async_trait::async_trait;
use reqwest::{Client, Method};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::error::{ErrorCode, HostdError};

#[async_trait]
pub(super) trait LocalApi: Send + Sync {
    async fn request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, HostdError>;
}

pub(super) struct SocketApi {
    client: Client,
}

impl SocketApi {
    pub(super) fn new(socket: &Path) -> Result<Self, HostdError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .unix_socket(socket)
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| HostdError::unavailable("Tailscale LocalAPI client is unavailable"))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl LocalApi for SocketApi {
    async fn request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, HostdError> {
        let mut request = self.client.request(
            Method::from_bytes(method.as_bytes())
                .map_err(|_| HostdError::validation("Invalid Tailscale operation"))?,
            format!("http://local-tailscaled.sock/localapi/v0/{endpoint}"),
        );
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                HostdError::new(504, ErrorCode::Timeout, "Tailscale LocalAPI timed out")
            } else {
                HostdError::unavailable("Tailscale LocalAPI is unavailable")
            }
        })?;
        // Daemon error bodies can contain credentials. Never forward or log them.
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => {
                    HostdError::new(403, ErrorCode::Forbidden, "Tailscale denied this operation")
                }
                400 => HostdError::validation(
                    "Tailscale rejected the requested configuration or authentication",
                ),
                _ => HostdError::operation_failed("Tailscale could not complete the operation"),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| HostdError::unavailable("Tailscale response was interrupted"))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(HostdError::new(
                    502,
                    ErrorCode::OutputTooLarge,
                    "Tailscale response exceeded the limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| HostdError::operation_failed("Invalid Tailscale response"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn uses_fixed_local_http_path_and_never_exposes_error_bodies() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("tailscaled.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            for response in [
                "HTTP/1.1 200 OK\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"BackendState\":\"Running\"}",
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 15\r\nConnection: close\r\n\r\nsecret-auth-key!",
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                let request = std::str::from_utf8(&buffer[..count]).unwrap();
                assert!(request.starts_with("GET /localapi/v0/status HTTP/1.1\r\n"));
                assert!(request.contains("host: local-tailscaled.sock\r\n"));
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let api = SocketApi::new(&socket).unwrap();
        assert_eq!(
            api.request("GET", "status", None).await.unwrap()["BackendState"],
            "Running"
        );
        let error = api.request("GET", "status", None).await.unwrap_err();
        assert_eq!(error.status, 403);
        assert!(!error.message.contains("secret"));
        server.await.unwrap();
    }
}
