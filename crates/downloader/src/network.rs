use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use reqwest::header::{ACCEPT_ENCODING, HOST, IF_RANGE, LOCATION, RANGE, RETRY_AFTER, USER_AGENT};
use reqwest::{Client, Response, StatusCode};
use tokio::net::lookup_host;
use url::{Host, Url};

use crate::error::{DownloadError, ErrorCode};
use crate::retry::parse_retry_after;

const MAX_REDIRECTS: usize = 5;
static RUSTLS_PROVIDER: OnceLock<()> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub connect_timeout: Duration,
    pub header_timeout: Duration,
    pub read_idle_timeout: Duration,
    #[cfg(test)]
    pub allow_private_ips: bool,
    #[cfg(test)]
    pub resolved_addresses: Option<(String, Vec<SocketAddr>)>,
}

#[derive(Debug, Clone, Default)]
pub struct RangeRequest {
    pub start: Option<u64>,
    pub end_inclusive: Option<u64>,
    pub if_range: Option<String>,
}

pub async fn get(
    raw_url: &str,
    options: &RequestOptions,
    range: &RangeRequest,
) -> Result<(Response, Url), DownloadError> {
    let mut url = parse_url(raw_url)?;
    for redirect in 0..=MAX_REDIRECTS {
        let response = send_once(&url, options, range).await?;
        if response.status().is_redirection() {
            let location = response.headers().get(LOCATION).ok_or_else(|| {
                DownloadError::new(
                    ErrorCode::RedirectPolicy,
                    "redirect response omitted Location",
                    false,
                )
            })?;
            if redirect == MAX_REDIRECTS {
                return Err(DownloadError::new(
                    ErrorCode::RedirectPolicy,
                    "download redirected too many times",
                    false,
                ));
            }
            let location = location.to_str().map_err(|_| {
                DownloadError::new(
                    ErrorCode::RedirectPolicy,
                    "redirect Location is not valid text",
                    false,
                )
            })?;
            let next = url.join(location).map_err(|_| {
                DownloadError::new(
                    ErrorCode::RedirectPolicy,
                    "redirect Location is invalid",
                    false,
                )
            })?;
            validate_url(&next)?;
            if !redirect_scheme_allowed(url.scheme(), next.scheme()) {
                return Err(DownloadError::new(
                    ErrorCode::RedirectPolicy,
                    "HTTPS downloads cannot redirect to HTTP",
                    false,
                ));
            }
            url = next;
            continue;
        }
        if is_retryable_status(response.status()) {
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| parse_retry_after(value, SystemTime::now()));
            return Err(DownloadError::new(
                ErrorCode::HttpStatus,
                format!(
                    "download server returned HTTP {}",
                    response.status().as_u16()
                ),
                true,
            )
            .retry_after(retry_after));
        }
        return Ok((response, url));
    }
    unreachable!("redirect loop returns before exceeding its bound")
}

pub fn parse_url(raw: &str) -> Result<Url, DownloadError> {
    let url = Url::parse(raw).map_err(|_| {
        DownloadError::new(ErrorCode::RedirectPolicy, "download URL is invalid", false)
    })?;
    validate_url(&url)?;
    Ok(url)
}

fn validate_url(url: &Url) -> Result<(), DownloadError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(DownloadError::new(
            ErrorCode::RedirectPolicy,
            "only HTTP and HTTPS downloads are supported",
            false,
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(DownloadError::new(
            ErrorCode::RedirectPolicy,
            "download URLs with credentials are not supported",
            false,
        ));
    }
    if url.host_str().is_none() {
        return Err(DownloadError::new(
            ErrorCode::RedirectPolicy,
            "download URL has no host",
            false,
        ));
    }
    Ok(())
}

async fn send_once(
    url: &Url,
    options: &RequestOptions,
    range: &RangeRequest,
) -> Result<Response, DownloadError> {
    install_rustls_provider();
    let host = url.host_str().expect("validated URL has a host");
    let port = url
        .port_or_known_default()
        .expect("HTTP URLs have a known port");
    #[cfg(test)]
    let allow_private_ips = options.allow_private_ips;
    #[cfg(not(test))]
    let allow_private_ips = false;
    #[cfg(test)]
    let injected_addresses = options
        .resolved_addresses
        .as_ref()
        .filter(|(resolved_host, _)| resolved_host == host)
        .map(|(_, addresses)| addresses.clone());
    #[cfg(test)]
    let addresses = match injected_addresses {
        Some(addresses) => addresses,
        None => {
            resolve_public_addresses(host, port, options.connect_timeout, allow_private_ips).await?
        }
    };
    #[cfg(not(test))]
    let addresses =
        resolve_public_addresses(host, port, options.connect_timeout, allow_private_ips).await?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(options.connect_timeout)
        .read_timeout(options.read_idle_timeout)
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(classify_reqwest_error)?;
    let mut request = client
        .get(url.clone())
        .header(USER_AGENT, "CyberOS Downloader")
        .header(ACCEPT_ENCODING, "identity")
        .header(HOST, host_header(url));
    if let Some(start) = range.start {
        let value = range
            .end_inclusive
            .map(|end| format!("bytes={start}-{end}"))
            .unwrap_or_else(|| format!("bytes={start}-"));
        request = request.header(RANGE, value);
    }
    if let Some(validator) = &range.if_range {
        request = request.header(IF_RANGE, validator);
    }
    tokio::time::timeout(options.header_timeout, request.send())
        .await
        .map_err(|_| {
            DownloadError::new(
                ErrorCode::Timeout,
                "download response header timed out",
                true,
            )
        })?
        .map_err(classify_reqwest_error)
}

fn install_rustls_provider() {
    RUSTLS_PROVIDER.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

fn host_header(url: &Url) -> String {
    let host = match url.host().expect("validated host") {
        Host::Ipv6(address) => format!("[{address}]"),
        Host::Ipv4(address) => address.to_string(),
        Host::Domain(domain) => domain.to_owned(),
    };
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

async fn resolve_public_addresses(
    host: &str,
    port: u16,
    timeout: Duration,
    allow_private_ips: bool,
) -> Result<Vec<SocketAddr>, DownloadError> {
    let addresses: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(address) => vec![SocketAddr::new(address, port)],
        Err(_) => tokio::time::timeout(timeout, lookup_host((host, port)))
            .await
            .map_err(|_| DownloadError::new(ErrorCode::Timeout, "DNS lookup timed out", true))?
            .map_err(|error| DownloadError::new(ErrorCode::Dns, error.to_string(), true))?
            .collect(),
    };
    let mut public: Vec<_> = addresses
        .into_iter()
        .filter(|address| allow_private_ips || is_public_ip(address.ip()))
        .collect();
    public.sort_unstable();
    public.dedup();
    if public.is_empty() {
        return Err(DownloadError::new(
            ErrorCode::SsrfBlocked,
            "download host must resolve only through a public IP address",
            false,
        ));
    }
    Ok(public)
}

fn redirect_scheme_allowed(original_scheme: &str, next_scheme: &str) -> bool {
    original_scheme != "https" || next_scheme == "https"
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    let denied = [
        (0x0000_0000, 0x00ff_ffff),
        (0x0a00_0000, 0x0aff_ffff),
        (0x6440_0000, 0x647f_ffff),
        (0x7f00_0000, 0x7fff_ffff),
        (0xa9fe_0000, 0xa9fe_ffff),
        (0xac10_0000, 0xac1f_ffff),
        (0xc000_0000, 0xc000_00ff),
        (0xc000_0200, 0xc000_02ff),
        (0xc0a8_0000, 0xc0a8_ffff),
        (0xc612_0000, 0xc613_ffff),
        (0xc633_6400, 0xc633_64ff),
        (0xcb00_7100, 0xcb00_71ff),
        (0xe000_0000, 0xffff_ffff),
    ];
    !denied
        .iter()
        .any(|(start, end)| value >= *start && value <= *end)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let value = u128::from(address);
    let in_prefix = |network: u128, prefix: u32| {
        let mask = if prefix == 0 {
            0
        } else {
            u128::MAX << (128 - prefix)
        };
        value & mask == network & mask
    };
    in_prefix(u128::from(Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0)), 3)
        && !in_prefix(
            u128::from(Ipv6Addr::new(0x2001, 0x0002, 0, 0, 0, 0, 0, 0)),
            48,
        )
        && !in_prefix(
            u128::from(Ipv6Addr::new(0x2001, 0x0010, 0, 0, 0, 0, 0, 0)),
            28,
        )
        && !in_prefix(
            u128::from(Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0)),
            32,
        )
        && !in_prefix(u128::from(Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0)), 20)
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

fn classify_reqwest_error(error: reqwest::Error) -> DownloadError {
    if error.is_timeout() {
        return DownloadError::new(ErrorCode::Timeout, error.to_string(), true);
    }
    if error.is_connect() {
        let message = error.to_string();
        let code = if message.to_ascii_lowercase().contains("certificate") {
            ErrorCode::Tls
        } else {
            ErrorCode::Connect
        };
        return DownloadError::new(code, message, code != ErrorCode::Tls);
    }
    DownloadError::new(ErrorCode::Connect, error.to_string(), true)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn validates_urls_and_rejects_credentials() {
        assert!(parse_url("https://example.com/file.bin").is_ok());
        assert!(parse_url("ftp://example.com/file.bin").is_err());
        assert!(parse_url("https://user:secret@example.com/file.bin").is_err());
    }

    #[test]
    fn rejects_non_public_networks() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.1.1",
            "192.168.1.1",
            "198.51.100.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(
                !is_public_ip(address.parse().unwrap()),
                "{address} must be blocked"
            );
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn rejects_https_downgrade_redirects() {
        assert!(redirect_scheme_allowed("http", "http"));
        assert!(redirect_scheme_allowed("http", "https"));
        assert!(redirect_scheme_allowed("https", "https"));
        assert!(!redirect_scheme_allowed("https", "http"));
    }

    #[test]
    fn retries_only_the_configured_transient_http_statuses() {
        for status in [408, 425, 429, 500, 502, 503, 504] {
            assert!(is_retryable_status(StatusCode::from_u16(status).unwrap()));
        }
        for status in [400, 401, 403, 404, 409, 501] {
            assert!(!is_retryable_status(StatusCode::from_u16(status).unwrap()));
        }
    }

    #[test]
    fn formats_ipv6_host_headers_with_brackets() {
        assert_eq!(
            host_header(&Url::parse("https://[2606:4700:4700::1111]:8443/file").unwrap()),
            "[2606:4700:4700::1111]:8443"
        );
    }

    #[tokio::test]
    async fn handles_successful_range_and_unsatisfied_range_responses() {
        let url = serve(vec![
            response("200 OK", &[(&"Content-Length", &"5")], "hello"),
            response(
                "206 Partial Content",
                &[
                    (&"Content-Length", &"1"),
                    (&"Content-Range", &"bytes 0-0/5"),
                    (&"ETag", &"\"v1\""),
                ],
                "h",
            ),
            response(
                "416 Range Not Satisfiable",
                &[(&"Content-Range", &"bytes */0")],
                "",
            ),
        ])
        .await;
        let options = test_options();

        let (mut full, _) = get(&url, &options, &RangeRequest::default()).await.unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.chunk().await.unwrap().unwrap(), "hello");

        let (partial, _) = get(
            &url,
            &options,
            &RangeRequest {
                start: Some(0),
                end_inclusive: Some(0),
                if_range: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()["content-range"], "bytes 0-0/5");

        let (unsatisfied, _) = get(
            &url,
            &options,
            &RangeRequest {
                start: Some(0),
                end_inclusive: Some(0),
                if_range: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(unsatisfied.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[tokio::test]
    async fn follows_safe_redirects_and_classifies_retryable_statuses() {
        let url = serve(vec![
            response("302 Found", &[(&"Location", &"/final")], ""),
            response("200 OK", &[(&"Content-Length", &"2")], "ok"),
            response("429 Too Many Requests", &[(&"Retry-After", &"7")], ""),
        ])
        .await;
        let options = test_options();

        let (success, final_url) = get(&url, &options, &RangeRequest::default()).await.unwrap();
        assert_eq!(success.status(), StatusCode::OK);
        assert_eq!(final_url.path(), "/final");

        let error = get(&url, &options, &RangeRequest::default())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::HttpStatus);
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(7_000));
    }

    #[tokio::test]
    async fn enforces_header_and_read_idle_timeouts() {
        let header_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let header_url = format!("http://{}/headers", header_listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (_socket, _) = header_listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let mut options = test_options();
        options.header_timeout = Duration::from_millis(20);
        let error = get(&header_url, &options, &RangeRequest::default())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);

        let body_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let body_url = format!("http://{}/body", body_listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = body_listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\na")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let mut options = test_options();
        options.read_idle_timeout = Duration::from_millis(20);
        let (response, _) = get(&body_url, &options, &RangeRequest::default())
            .await
            .unwrap();
        assert!(response.bytes().await.unwrap_err().is_timeout());
    }

    #[tokio::test]
    async fn blocks_private_redirects_after_public_dns_pinning() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/private\r\nContent-Length: 0\r\n\r\n",
                        address.port()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let mut options = test_options();
        options.allow_private_ips = false;
        options.resolved_addresses = Some(("public.test".to_owned(), vec![address]));
        let error = get(
            &format!("http://public.test:{}/start", address.port()),
            &options,
            &RangeRequest::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::SsrfBlocked);
    }

    #[tokio::test]
    async fn falls_back_across_all_pinned_addresses() {
        let refused = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let refused_address = refused.local_addr().unwrap();
        drop(refused);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
        });
        let mut options = test_options();
        options.resolved_addresses =
            Some(("fallback.test".to_owned(), vec![refused_address, address]));
        let (response, _) = get(
            &format!("http://fallback.test:{}/file", address.port()),
            &options,
            &RangeRequest::default(),
        )
        .await
        .unwrap();
        assert_eq!(response.bytes().await.unwrap(), "ok");
    }

    fn test_options() -> RequestOptions {
        RequestOptions {
            connect_timeout: Duration::from_secs(2),
            header_timeout: Duration::from_secs(2),
            read_idle_timeout: Duration::from_secs(2),
            allow_private_ips: true,
            resolved_addresses: None,
        }
    }

    async fn serve(responses: Vec<String>) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let responses = Arc::new(responses);
        tokio::spawn(async move {
            for response in responses.iter() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                loop {
                    let read = socket.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        format!("http://{address}/start")
    }

    fn response(status: &str, headers: &[(&&str, &&str)], body: &str) -> String {
        let mut response = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        response.push_str(body);
        response
    }
}
