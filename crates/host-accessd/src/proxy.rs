use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map as JsonMap, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;

const REQUEST_LIMIT: usize = 64 * 1024;
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 32;

pub async fn serve(listener: UnixListener, upstream: PathBuf) -> std::io::Result<()> {
    let permits = std::sync::Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, _) = listener.accept().await?;
        let permit = match permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tokio::spawn(async move {
                    let _ = reject(stream, 429, "too_many_requests").await;
                });
                continue;
            }
        };
        let next_upstream = upstream.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = proxy_request(stream, next_upstream).await {
                tracing::warn!(message = %error, "docker metadata request rejected");
            }
        });
    }
}

async fn proxy_request(mut client: UnixStream, upstream_path: PathBuf) -> std::io::Result<()> {
    let request = match read_headers(&mut client, REQUEST_LIMIT).await {
        Ok(request) => request,
        Err(error) => {
            let _ = reject(client, 400, "invalid_request").await;
            return Err(error);
        }
    };
    let Some((method, target, route)) = authorize_request(&request) else {
        return reject(client, 403, "request_denied").await;
    };
    let mut upstream = match timeout(IO_TIMEOUT, UnixStream::connect(upstream_path)).await {
        Ok(Ok(stream)) => stream,
        _ => return reject(client, 503, "docker_unavailable").await,
    };
    let outbound = format!(
        "{method} {target} HTTP/1.1\r\nHost: docker\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    timeout(IO_TIMEOUT, upstream.write_all(outbound.as_bytes())).await??;
    let response = read_to_end_limited(&mut upstream, RESPONSE_LIMIT).await?;
    let sanitized = sanitize_response(&response, route)?;
    timeout(IO_TIMEOUT, client.write_all(&sanitized)).await??;
    client.shutdown().await
}

#[derive(Clone, Copy)]
enum Route {
    Ping,
    Version,
    Info,
    Containers,
    Container,
    Networks,
    Network,
}

fn authorize_request(request: &[u8]) -> Option<(&str, &str, Route)> {
    let text = std::str::from_utf8(request).ok()?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?;
    let target = request_line.next()?;
    if request_line.next() != Some("HTTP/1.1") || request_line.next().is_some() {
        return None;
    }
    if method != "GET" && method != "HEAD" {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    if !target.starts_with('/')
        || target.len() > 4096
        || lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%2e")
        || target.contains("..")
    {
        return None;
    }
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:")
            || lower.starts_with("transfer-encoding:")
            || lower.starts_with("connection: upgrade")
        {
            return None;
        }
    }
    let (path_and_version, query) = target.split_once('?').unwrap_or((target, ""));
    let path = strip_api_version(path_and_version)?;
    match path {
        "/_ping" if query.is_empty() => Some((method, target, Route::Ping)),
        "/version" if method == "GET" && query.is_empty() => Some((method, target, Route::Version)),
        "/info" if method == "GET" && query.is_empty() => Some((method, target, Route::Info)),
        "/containers/json"
            if method == "GET"
                && valid_query(query, &["all", "size", "limit", "since", "before"]) =>
        {
            Some((method, target, Route::Containers))
        }
        "/networks" if method == "GET" && query.is_empty() => {
            Some((method, target, Route::Networks))
        }
        _ if method == "GET" && query.is_empty() && container_inspect_path(path) => {
            Some((method, target, Route::Container))
        }
        _ if method == "GET" && query.is_empty() && network_inspect_path(path) => {
            Some((method, target, Route::Network))
        }
        _ => None,
    }
}

fn strip_api_version(path: &str) -> Option<&str> {
    if !path.starts_with("/v1.") {
        return Some(path);
    }
    let slash = path[1..].find('/')? + 1;
    let version = &path[1..slash];
    if version[3..].bytes().all(|byte| byte.is_ascii_digit()) {
        Some(&path[slash..])
    } else {
        None
    }
}

fn valid_query(query: &str, allowed: &[&str]) -> bool {
    query.len() <= 2048
        && query
            .split('&')
            .filter(|part| !part.is_empty())
            .all(|part| {
                let key = part.split_once('=').map_or(part, |(key, _)| key);
                allowed.contains(&key)
            })
}

fn container_inspect_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 4 && parts[1] == "containers" && valid_identifier(parts[2]) && parts[3] == "json"
}

fn network_inspect_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 3 && parts[1] == "networks" && valid_identifier(parts[2])
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

async fn read_headers(stream: &mut UnixStream, limit: usize) -> std::io::Result<Vec<u8>> {
    timeout(IO_TIMEOUT, async {
        let mut data = Vec::new();
        loop {
            let mut chunk = [0_u8; 2048];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "request ended before headers",
                ));
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() > limit {
                return Err(std::io::Error::other("request too large"));
            }
            if data.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(data);
            }
        }
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "request timed out"))?
}

async fn read_to_end_limited(stream: &mut UnixStream, limit: usize) -> std::io::Result<Vec<u8>> {
    timeout(IO_TIMEOUT, async {
        let mut data = Vec::new();
        loop {
            let mut chunk = [0_u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Ok(data);
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() > limit {
                return Err(std::io::Error::other("response too large"));
            }
        }
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "response timed out"))?
}

fn sanitize_response(response: &[u8], route: Route) -> std::io::Result<Vec<u8>> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| std::io::Error::other("invalid docker response"))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| std::io::Error::other("invalid docker headers"))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .filter(|status| status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| std::io::Error::other("invalid docker status"))?;
    let raw_body = &response[header_end + 4..];
    let body = decode_response_body(headers, raw_body)?;
    if matches!(route, Route::Ping) {
        return http_response(status, "text/plain", &body);
    }
    let parsed: Value =
        serde_json::from_slice(&body).map_err(|_| std::io::Error::other("invalid docker json"))?;
    let clean = sanitize_json(parsed, route);
    let payload = serde_json::to_vec(&clean).map_err(std::io::Error::other)?;
    http_response(status, "application/json", &payload)
}

fn decode_response_body(headers: &str, body: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut chunked = false;
    let mut content_length = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(std::io::Error::other("invalid docker header"));
        };
        if name.eq_ignore_ascii_case("transfer-encoding") {
            if !value.trim().eq_ignore_ascii_case("chunked") || chunked {
                return Err(std::io::Error::other(
                    "unsupported docker transfer encoding",
                ));
            }
            chunked = true;
        } else if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(std::io::Error::other("duplicate docker content length"));
            }
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| std::io::Error::other("invalid docker content length"))?,
            );
        }
    }
    if chunked && content_length.is_some() {
        return Err(std::io::Error::other("ambiguous docker response framing"));
    }
    if chunked {
        return decode_chunked_body(body);
    }
    if let Some(length) = content_length
        && (length > RESPONSE_LIMIT || body.len() != length)
    {
        return Err(std::io::Error::other("invalid docker response length"));
    }
    Ok(body.to_vec())
}

fn decode_chunked_body(mut input: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let line_end = input
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| std::io::Error::other("invalid docker chunk header"))?;
        let size_text = std::str::from_utf8(&input[..line_end])
            .map_err(|_| std::io::Error::other("invalid docker chunk header"))?;
        let size_token = size_text
            .split_once(';')
            .map_or(size_text, |(size, _)| size)
            .trim();
        if size_token.is_empty() || size_token.len() > 16 {
            return Err(std::io::Error::other("invalid docker chunk size"));
        }
        let size = usize::from_str_radix(size_token, 16)
            .map_err(|_| std::io::Error::other("invalid docker chunk size"))?;
        input = &input[line_end + 2..];
        if size == 0 {
            if input == b"\r\n" || input.starts_with(b"\r\n") {
                return Ok(output);
            }
            let trailer_end = input
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .ok_or_else(|| std::io::Error::other("invalid docker chunk trailer"))?;
            if trailer_end > REQUEST_LIMIT {
                return Err(std::io::Error::other("docker chunk trailer too large"));
            }
            return Ok(output);
        }
        if size > RESPONSE_LIMIT.saturating_sub(output.len()) || input.len() < size + 2 {
            return Err(std::io::Error::other(
                "docker chunk body too large or truncated",
            ));
        }
        output.extend_from_slice(&input[..size]);
        if &input[size..size + 2] != b"\r\n" {
            return Err(std::io::Error::other("invalid docker chunk terminator"));
        }
        input = &input[size + 2..];
    }
}

fn http_response(status: &str, content_type: &str, body: &[u8]) -> std::io::Result<Vec<u8>> {
    let reason = if status.starts_with('2') {
        "OK"
    } else {
        "Upstream Error"
    };
    let mut response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    response.extend_from_slice(body);
    Ok(response)
}

fn sanitize_json(value: Value, route: Route) -> Value {
    match route {
        Route::Version => pick(
            value,
            &[
                "Version",
                "ApiVersion",
                "MinAPIVersion",
                "GitCommit",
                "GoVersion",
                "Os",
                "Arch",
                "KernelVersion",
                "BuildTime",
            ],
        ),
        Route::Info => pick(
            value,
            &[
                "ID",
                "Containers",
                "ContainersRunning",
                "ContainersPaused",
                "ContainersStopped",
                "Images",
                "Driver",
                "MemoryLimit",
                "SwapLimit",
                "CpuCfsPeriod",
                "CpuCfsQuota",
                "CPUShares",
                "CPUSet",
                "PidsLimit",
                "OSType",
                "Architecture",
                "NCPU",
                "MemTotal",
            ],
        ),
        Route::Containers => Value::Array(
            value
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .cloned()
                        .map(sanitize_container_summary)
                        .collect()
                })
                .unwrap_or_default(),
        ),
        Route::Container => sanitize_container_inspect(value),
        Route::Networks => Value::Array(
            value
                .as_array()
                .map(|items| items.iter().cloned().map(sanitize_network).collect())
                .unwrap_or_default(),
        ),
        Route::Network => sanitize_network(value),
        Route::Ping => Value::Null,
    }
}

fn sanitize_container_summary(value: Value) -> Value {
    let mut result = pick_map(
        &value,
        &[
            "Id", "Names", "Image", "ImageID", "Created", "State", "Status",
        ],
    );
    if let Some(ports) = value.get("Ports").and_then(Value::as_array) {
        result.insert(
            "Ports".into(),
            Value::Array(
                ports
                    .iter()
                    .cloned()
                    .map(|port| pick(port, &["IP", "PrivatePort", "PublicPort", "Type"]))
                    .collect(),
            ),
        );
    }
    if let Some(labels) = value.get("Labels") {
        result.insert("Labels".into(), safe_labels(labels));
    }
    if let Some(network) = value.get("NetworkSettings") {
        result.insert("NetworkSettings".into(), sanitize_network_settings(network));
    }
    Value::Object(result)
}

fn sanitize_container_inspect(value: Value) -> Value {
    let mut result = pick_map(&value, &["Id", "Name", "Created", "Image"]);
    if let Some(state) = value.get("State") {
        result.insert(
            "State".into(),
            pick(
                state.clone(),
                &[
                    "Status",
                    "Running",
                    "Paused",
                    "Restarting",
                    "OOMKilled",
                    "Dead",
                    "Pid",
                    "ExitCode",
                    "StartedAt",
                    "FinishedAt",
                ],
            ),
        );
    }
    if let Some(config) = value.get("Config") {
        let mut safe = pick_map(config, &["Hostname", "Image"]);
        if let Some(labels) = config.get("Labels") {
            safe.insert("Labels".into(), safe_labels(labels));
        }
        result.insert("Config".into(), Value::Object(safe));
    }
    if let Some(host) = value.get("HostConfig") {
        let mut safe = pick_map(host, &["NetworkMode", "ReadonlyRootfs"]);
        if let Some(restart) = host.get("RestartPolicy") {
            safe.insert(
                "RestartPolicy".into(),
                pick(restart.clone(), &["Name", "MaximumRetryCount"]),
            );
        }
        result.insert("HostConfig".into(), Value::Object(safe));
    }
    if let Some(network) = value.get("NetworkSettings") {
        result.insert("NetworkSettings".into(), sanitize_network_settings(network));
    }
    if let Some(mounts) = value.get("Mounts").and_then(Value::as_array) {
        result.insert(
            "Mounts".into(),
            Value::Array(
                mounts
                    .iter()
                    .cloned()
                    .map(|mount| pick(mount, &["Type", "Destination", "Mode", "RW", "Propagation"]))
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}

fn sanitize_network(value: Value) -> Value {
    let mut result = pick_map(
        &value,
        &[
            "Name",
            "Id",
            "Created",
            "Scope",
            "Driver",
            "EnableIPv6",
            "Internal",
            "Attachable",
            "Ingress",
        ],
    );
    if let Some(ipam) = value.get("IPAM") {
        result.insert("IPAM".into(), sanitize_ipam(ipam));
    }
    if let Some(labels) = value.get("Labels") {
        result.insert("Labels".into(), safe_labels(labels));
    }
    if let Some(containers) = value.get("Containers").and_then(Value::as_object) {
        result.insert(
            "Containers".into(),
            Value::Object(
                containers
                    .iter()
                    .map(|(id, entry)| {
                        (
                            id.clone(),
                            pick(
                                entry.clone(),
                                &[
                                    "Name",
                                    "EndpointID",
                                    "MacAddress",
                                    "IPv4Address",
                                    "IPv6Address",
                                ],
                            ),
                        )
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}

fn sanitize_network_settings(value: &Value) -> Value {
    let mut result = pick_map(
        value,
        &[
            "Bridge",
            "SandboxID",
            "HairpinMode",
            "EndpointID",
            "Gateway",
            "IPAddress",
            "IPPrefixLen",
            "IPv6Gateway",
            "GlobalIPv6Address",
            "GlobalIPv6PrefixLen",
            "MacAddress",
        ],
    );
    if let Some(ports) = value.get("Ports").and_then(Value::as_object) {
        result.insert(
            "Ports".into(),
            Value::Object(
                ports
                    .iter()
                    .map(|(port, bindings)| {
                        let safe = bindings
                            .as_array()
                            .map(|items| {
                                Value::Array(
                                    items
                                        .iter()
                                        .cloned()
                                        .map(|binding| pick(binding, &["HostIp", "HostPort"]))
                                        .collect(),
                                )
                            })
                            .unwrap_or(Value::Null);
                        (port.clone(), safe)
                    })
                    .collect(),
            ),
        );
    }
    if let Some(networks) = value.get("Networks").and_then(Value::as_object) {
        result.insert(
            "Networks".into(),
            Value::Object(
                networks
                    .iter()
                    .map(|(name, entry)| {
                        (
                            name.clone(),
                            pick(
                                entry.clone(),
                                &[
                                    "NetworkID",
                                    "EndpointID",
                                    "Gateway",
                                    "IPAddress",
                                    "IPPrefixLen",
                                    "IPv6Gateway",
                                    "GlobalIPv6Address",
                                    "GlobalIPv6PrefixLen",
                                    "MacAddress",
                                ],
                            ),
                        )
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}

fn sanitize_ipam(value: &Value) -> Value {
    let mut result = pick_map(value, &["Driver"]);
    if let Some(config) = value.get("Config").and_then(Value::as_array) {
        result.insert(
            "Config".into(),
            Value::Array(
                config
                    .iter()
                    .cloned()
                    .map(|entry| {
                        pick(
                            entry,
                            &["Subnet", "IPRange", "Gateway", "AuxiliaryAddresses"],
                        )
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}

fn safe_labels(value: &Value) -> Value {
    let allowed = [
        "com.docker.compose.project",
        "com.docker.compose.service",
        "com.docker.compose.container-number",
        "io.zos.managed",
    ];
    Value::Object(
        value
            .as_object()
            .map(|labels| {
                labels
                    .iter()
                    .filter(|(key, _)| allowed.contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn pick(value: Value, keys: &[&str]) -> Value {
    Value::Object(pick_map(&value, keys))
}

fn pick_map(value: &Value, keys: &[&str]) -> JsonMap<String, Value> {
    value
        .as_object()
        .map(|object| {
            keys.iter()
                .filter_map(|key| {
                    object
                        .get(*key)
                        .map(|value| ((*key).to_owned(), value.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn reject(mut stream: UnixStream, status: u16, code: &str) -> std::io::Result<()> {
    let body =
        serde_json::to_vec(&serde_json::json!({ "error": code })).map_err(std::io::Error::other)?;
    let response = http_response(&status.to_string(), "application/json", &body)?;
    stream.write_all(&response).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_read_only_inventory_routes() {
        assert!(
            authorize_request(b"GET /v1.45/containers/json?all=1 HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_some()
        );
        assert!(
            authorize_request(b"GET /networks/abc-123 HTTP/1.1\r\nHost: docker\r\n\r\n").is_some()
        );
        assert!(
            authorize_request(b"POST /containers/abc/stop HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_none()
        );
        assert!(
            authorize_request(b"GET /containers/json?unknown=1 HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_none()
        );
        assert!(
            authorize_request(b"GET /containers/json?filters=%7B%22label%22%3A%5B%22secret%3Dguess%22%5D%7D HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_none()
        );
        assert!(
            authorize_request(b"GET /networks?filters=%7B%7D HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_none()
        );
        assert!(
            authorize_request(b"GET /containers/%2e%2e/json HTTP/1.1\r\nHost: docker\r\n\r\n")
                .is_none()
        );
        assert!(
            authorize_request(b"GET /info HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
                .is_none()
        );
    }

    #[test]
    fn removes_secrets_commands_and_host_mount_sources() {
        let value = serde_json::json!({
            "Id": "container",
            "Path": "/bin/secret",
            "Args": ["--token", "secret"],
            "Config": {
                "Hostname": "collector",
                "Image": "collector:latest",
                "Env": ["TOKEN=secret"],
                "Cmd": ["--token", "secret"],
                "Labels": {
                    "com.docker.compose.project": "monitoring",
                    "secret.label": "secret"
                }
            },
            "HostConfig": {
                "NetworkMode": "bridge",
                "RestartPolicy": {
                    "Name": "unless-stopped",
                    "MaximumRetryCount": 3,
                    "Secret": "restart-policy-secret"
                }
            },
            "NetworkSettings": {
                "SandboxKey": "/var/run/docker/netns/secret",
                "Ports": {
                    "19999/tcp": [{
                        "HostIp": "127.0.0.1",
                        "HostPort": "19999",
                        "Secret": "port-binding-secret"
                    }]
                }
            },
            "Mounts": [{ "Type": "bind", "Source": "/secret/host", "Destination": "/data", "RW": false }]
        });
        let safe = sanitize_container_inspect(value);
        let encoded = serde_json::to_string(&safe).unwrap();
        assert!(encoded.contains("monitoring"));
        assert!(encoded.contains("/data"));
        assert!(!encoded.contains("TOKEN"));
        assert!(!encoded.contains("secret.label"));
        assert!(!encoded.contains("/secret/host"));
        assert!(!encoded.contains("/bin/secret"));
        assert!(!encoded.contains("restart-policy-secret"));
        assert!(!encoded.contains("/var/run/docker/netns/secret"));
        assert!(!encoded.contains("port-binding-secret"));
        assert!(encoded.contains("unless-stopped"));
        assert!(encoded.contains("19999"));
    }

    #[test]
    fn filters_nested_network_ipam_fields() {
        let safe = sanitize_network(serde_json::json!({
            "Name": "monitoring",
            "IPAM": {
                "Driver": "default",
                "Secret": "ipam-secret",
                "Config": [{
                    "Subnet": "172.30.0.0/16",
                    "Gateway": "172.30.0.1",
                    "Secret": "ipam-config-secret"
                }]
            }
        }));
        let encoded = serde_json::to_string(&safe).unwrap();
        assert!(encoded.contains("172.30.0.0/16"));
        assert!(!encoded.contains("ipam-secret"));
        assert!(!encoded.contains("ipam-config-secret"));
    }

    #[test]
    fn decodes_chunked_docker_responses_before_sanitizing() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"Ve\r\n10\r\nrsion\":\"26.1.0\"}\r\n0\r\n\r\n";
        let sanitized = sanitize_response(response, Route::Version).unwrap();
        let text = std::str::from_utf8(&sanitized).unwrap();
        assert!(text.contains("Content-Length: 20"));
        assert!(text.ends_with("{\"Version\":\"26.1.0\"}"));
        assert!(!text.to_ascii_lowercase().contains("transfer-encoding"));
    }

    #[test]
    fn rejects_ambiguous_or_truncated_response_framing() {
        assert!(sanitize_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n0\r\n\r\n",
            Route::Version
        )
        .is_err());
        assert!(
            sanitize_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{}\r\n0\r\n\r\n",
                Route::Version
            )
            .is_err()
        );
    }
}
