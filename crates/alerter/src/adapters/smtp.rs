use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::domain::delivery::{ClaimedDelivery, SmtpSecurity, SmtpSettings};
use crate::error::AlerterError;
use crate::ports::MailTransport;

#[derive(Debug, Clone, Copy, Default)]
pub struct LettreMailTransport;

#[async_trait::async_trait]
impl MailTransport for LettreMailTransport {
    async fn deliver(
        &self,
        settings: &SmtpSettings,
        delivery: &ClaimedDelivery,
    ) -> Result<(), AlerterError> {
        deliver(settings, delivery).await
    }
}

pub async fn deliver(
    settings: &SmtpSettings,
    delivery: &ClaimedDelivery,
) -> Result<(), AlerterError> {
    if !settings.enabled {
        return Err(AlerterError::Smtp("SMTP delivery is disabled".to_owned()));
    }
    let addresses = resolve_destination(settings).await?;
    let from = settings
        .from
        .parse()
        .map_err(|_| AlerterError::Smtp("SMTP sender is invalid".to_owned()))?;
    let mut builder = Message::builder()
        .from(from)
        .subject(&delivery.subject)
        .message_id(Some(delivery.message_id.clone()))
        .header(ContentType::TEXT_PLAIN);
    for recipient in &delivery.recipients {
        builder = builder.to(recipient
            .parse()
            .map_err(|_| AlerterError::Smtp("SMTP recipient is invalid".to_owned()))?);
    }
    let message = builder
        .body(delivery.body.clone())
        .map_err(|_| AlerterError::Smtp("SMTP message is invalid".to_owned()))?;
    let mut transport = match settings.security {
        SmtpSecurity::None => {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(plaintext_server(&addresses))
        }
        SmtpSecurity::StartTls => {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&settings.host)
                .map_err(|_| AlerterError::Smtp("SMTP TLS configuration failed".to_owned()))?
        }
        SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&settings.host)
            .map_err(|_| AlerterError::Smtp("SMTP TLS configuration failed".to_owned()))?,
    }
    .port(settings.port)
    .timeout(Some(Duration::from_secs(30)));
    if !settings.username.is_empty() || !settings.password.is_empty() {
        transport = transport.credentials(Credentials::new(
            settings.username.clone(),
            settings.password.clone(),
        ));
    }
    transport
        .build()
        .send(message)
        .await
        .map_err(|_| AlerterError::Smtp("SMTP delivery failed".to_owned()))?;
    Ok(())
}

async fn resolve_destination(settings: &SmtpSettings) -> Result<Vec<IpAddr>, AlerterError> {
    let addresses: Vec<_> = tokio::net::lookup_host((settings.host.as_str(), settings.port))
        .await
        .map_err(|_| AlerterError::Smtp("SMTP host resolution failed".to_owned()))?
        .map(|address| address.ip())
        .collect();
    if addresses.is_empty() {
        return Err(AlerterError::Smtp(
            "SMTP host resolution returned no addresses".to_owned(),
        ));
    }
    validate_addresses(settings.security, &addresses)?;
    Ok(addresses)
}

fn plaintext_server(addresses: &[IpAddr]) -> String {
    addresses
        .iter()
        .find(|address| address.is_ipv4())
        .or_else(|| addresses.first())
        .map(ToString::to_string)
        .unwrap_or_default()
}

fn validate_addresses(security: SmtpSecurity, addresses: &[IpAddr]) -> Result<(), AlerterError> {
    if security == SmtpSecurity::None && !addresses.iter().all(|address| private(*address)) {
        return Err(AlerterError::Smtp(
            "Plaintext SMTP requires private addresses".to_owned(),
        ));
    }
    Ok(())
}

fn private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => private_v4(address),
        IpAddr::V6(address) => private_v6(address),
    }
}

fn private_v4(address: Ipv4Addr) -> bool {
    address.is_loopback() || address.is_private() || address.is_link_local()
}

fn private_v6(address: Ipv6Addr) -> bool {
    address.is_loopback()
        || address.is_unicast_link_local()
        || (address.segments()[0] & 0xfe00) == 0xfc00
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn settings(port: u16, security: SmtpSecurity) -> SmtpSettings {
        SmtpSettings {
            enabled: true,
            host: "127.0.0.1".to_owned(),
            port,
            security,
            username: "zos".to_owned(),
            password: "secret".to_owned(),
            from: "zos@example.test".to_owned(),
        }
    }

    fn delivery() -> ClaimedDelivery {
        ClaimedDelivery {
            id: "delivery-1".to_owned(),
            message_id: "<zos-alert-delivery-1@localhost>".to_owned(),
            recipients: vec!["operator@example.test".to_owned()],
            subject: "ZOS alert".to_owned(),
            body: "Alert body".to_owned(),
            attempt: 1,
        }
    }

    #[test]
    fn plaintext_address_policy_allows_only_private_ranges() {
        assert!(private("127.0.0.1".parse().unwrap()));
        assert!(private("10.1.2.3".parse().unwrap()));
        assert!(private("192.168.1.5".parse().unwrap()));
        assert!(private("fd00::1".parse().unwrap()));
        assert!(!private("0.0.0.0".parse().unwrap()));
        assert!(!private("::".parse().unwrap()));
        assert!(!private("8.8.8.8".parse().unwrap()));
        assert!(!private("2606:4700:4700::1111".parse().unwrap()));
        assert!(
            validate_addresses(
                SmtpSecurity::None,
                &["192.168.1.5".parse().unwrap(), "8.8.8.8".parse().unwrap()]
            )
            .is_err()
        );
        assert!(validate_addresses(SmtpSecurity::StartTls, &["8.8.8.8".parse().unwrap()]).is_ok());
        assert_eq!(
            plaintext_server(&["fd00::1".parse().unwrap(), "10.1.2.3".parse().unwrap()]),
            "10.1.2.3"
        );
    }

    #[tokio::test]
    async fn plaintext_private_smtp_uses_auth_and_preserves_message_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer.write_all(b"220 fake-smtp ESMTP\r\n").await.unwrap();
            let mut authenticated = false;
            let mut message = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                if line.starts_with("EHLO") {
                    writer
                        .write_all(b"250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n")
                        .await
                        .unwrap();
                } else if line.starts_with("AUTH PLAIN") {
                    authenticated = true;
                    writer
                        .write_all(b"235 2.7.0 authenticated\r\n")
                        .await
                        .unwrap();
                } else if line.starts_with("MAIL FROM") || line.starts_with("RCPT TO") {
                    writer.write_all(b"250 2.1.0 accepted\r\n").await.unwrap();
                } else if line.starts_with("DATA") {
                    writer.write_all(b"354 end with dot\r\n").await.unwrap();
                    loop {
                        let mut data = String::new();
                        reader.read_line(&mut data).await.unwrap();
                        if data == ".\r\n" {
                            break;
                        }
                        message.push_str(&data);
                    }
                    writer.write_all(b"250 2.0.0 queued\r\n").await.unwrap();
                    return (authenticated, message);
                } else {
                    writer.write_all(b"250 OK\r\n").await.unwrap();
                }
            }
            (authenticated, message)
        });

        deliver(&settings(port, SmtpSecurity::None), &delivery())
            .await
            .unwrap();
        let (authenticated, message) = server.await.unwrap();
        assert!(authenticated);
        assert!(message.contains("Message-ID: <zos-alert-delivery-1@localhost>"));
        assert!(message.contains("Alert body"));
    }

    #[tokio::test]
    async fn starttls_does_not_downgrade_when_the_server_omits_starttls() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer.write_all(b"220 fake-smtp ESMTP\r\n").await.unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            writer.write_all(b"250 fake-smtp\r\n").await.unwrap();
        });

        assert!(
            deliver(&settings(port, SmtpSecurity::StartTls), &delivery())
                .await
                .is_err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn implicit_tls_does_not_fall_back_to_plaintext() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            drop(stream);
        });

        assert!(
            deliver(&settings(port, SmtpSecurity::Tls), &delivery())
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}
