use serde::Deserialize;
use url::Url;

use crate::error::{ErrorCode, IndexerError};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Protocol {
    Http,
    Https,
    Socks5,
}

#[derive(Deserialize)]
struct ProxySettings {
    protocol: Protocol,
    host: String,
    port: u16,
}

pub(crate) fn client_builder(
    use_proxy: bool,
    settings_json: Option<&str>,
) -> Result<reqwest::ClientBuilder, IndexerError> {
    // Never inherit ambient HTTP_PROXY/ALL_PROXY: the module switch owns routing.
    let builder = reqwest::Client::builder().no_proxy();
    if !use_proxy {
        return Ok(builder);
    }
    let invalid = || {
        IndexerError::new(
            ErrorCode::CommandFailed,
            "System proxy settings are missing or invalid",
            false,
        )
    };
    let settings: ProxySettings =
        serde_json::from_str(settings_json.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if settings.port == 0
        || settings.host.is_empty()
        || settings.host.len() > 253
        || settings
            .host
            .chars()
            .any(|c| c.is_whitespace() || "/@?#%\\".contains(c))
    {
        return Err(invalid());
    }
    let host = if settings.host.contains(':') {
        format!("[{}]", settings.host)
    } else {
        settings.host
    };
    let scheme = match settings.protocol {
        Protocol::Http => "http",
        Protocol::Https => "https",
        // reqwest distinguishes SOCKS5 local DNS from SOCKS5h proxy-side DNS.
        Protocol::Socks5 => "socks5h",
    };
    let url = Url::parse(&format!("{scheme}://{host}:{}", settings.port)).map_err(|_| invalid())?;
    let proxy = reqwest::Proxy::all(url).map_err(|_| invalid())?;
    Ok(builder.proxy(proxy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::time::Duration;

    const CERT: &[u8] =
        include_bytes!("../../../packages/shared/test-fixtures/proxy/test-cert.pem");
    const KEY: &[u8] = include_bytes!("../../../packages/shared/test-fixtures/proxy/test-key.pem");
    const CA: &[u8] = include_bytes!("../../../packages/shared/test-fixtures/proxy/test-ca.pem");

    fn reply(mut stream: impl Read + Write) {
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
            assert!(request.len() < 4096);
        }
        assert!(
            String::from_utf8(request)
                .unwrap()
                .contains("does-not-resolve.invalid")
        );
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nrouted")
            .unwrap();
        stream.flush().unwrap();
    }

    fn socks(mut stream: TcpStream) {
        let mut greeting = [0; 2];
        stream.read_exact(&mut greeting).unwrap();
        assert_eq!(greeting[0], 5);
        let mut methods = vec![0; usize::from(greeting[1])];
        stream.read_exact(&mut methods).unwrap();
        stream.write_all(&[5, 0]).unwrap();
        let mut header = [0; 5];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(&header[..4], &[5, 1, 0, 3]);
        let mut domain_and_port = vec![0; usize::from(header[4]) + 2];
        stream.read_exact(&mut domain_and_port).unwrap();
        assert_eq!(
            &domain_and_port[..domain_and_port.len() - 2],
            b"does-not-resolve.invalid"
        );
        stream
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
            .unwrap();
        reply(stream);
    }

    #[tokio::test]
    async fn all_protocols_route_requests_and_socks_resolves_at_proxy() {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        for protocol in ["http", "https", "socks5"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                match protocol {
                    "https" => {
                        let config = rustls::ServerConfig::builder()
                            .with_no_client_auth()
                            .with_single_cert(
                                vec![CertificateDer::from_pem_slice(CERT).unwrap()],
                                PrivateKeyDer::from_pem_slice(KEY).unwrap(),
                            )
                            .unwrap();
                        reply(rustls::StreamOwned::new(
                            rustls::ServerConnection::new(Arc::new(config)).unwrap(),
                            stream,
                        ));
                    }
                    "socks5" => socks(stream),
                    _ => reply(stream),
                }
            });
            let json = format!(r#"{{"protocol":"{protocol}","host":"127.0.0.1","port":{port}}}"#);
            let client = client_builder(true, Some(&json))
                .unwrap()
                .tls_certs_only([reqwest::Certificate::from_pem(CA).unwrap()])
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let response = client
                .get("http://does-not-resolve.invalid/test")
                .send()
                .await;
            assert!(
                response.is_ok(),
                "{protocol} proxy request failed: {response:?}"
            );
            server.join().unwrap();
            assert_eq!(response.unwrap().text().await.unwrap(), "routed");
        }
    }

    #[test]
    fn invalid_proxy_configuration_never_falls_back_to_direct() {
        for json in [
            None,
            Some("{}"),
            Some(r#"{"protocol":"socks5","host":"localhost/path","port":1080}"#),
            Some(r#"{"protocol":"http","host":"localhost","port":0}"#),
        ] {
            assert!(client_builder(true, json).is_err());
            assert!(client_builder(false, json).is_ok());
        }
    }
}
