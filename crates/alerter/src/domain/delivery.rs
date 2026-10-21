#[derive(Debug, Clone)]
pub struct SmtpSettings {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub username: String,
    pub password: String,
    pub from: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    None,
    StartTls,
    Tls,
}

#[derive(Debug, Clone)]
pub struct ClaimedDelivery {
    pub id: String,
    pub message_id: String,
    pub recipients: Vec<String>,
    pub subject: String,
    pub body: String,
    pub attempt: i64,
}
