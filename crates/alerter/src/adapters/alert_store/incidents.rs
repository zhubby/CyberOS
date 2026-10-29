use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::AlertStore;
use super::codec::iso;
use super::deliveries::{add_event, add_event_with_details, queue_resolved_delivery};
use super::escalation::snapshot_policy_id;
use crate::error::AlerterError;

const HEALTH_EPISODE_COOLDOWN_MS: i64 = 60 * 60 * 1_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredHealthRouting {
    warning_policy_id: Option<String>,
    critical_policy_id: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
}

impl AlertStore {
    pub(super) fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), AlerterError> {
        let transaction = self.connection.transaction()?;
        let initialized: bool = transaction.query_row(
            "SELECT health_initialized FROM monitoring_alerter_state WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let now = iso(now_ms);
        let active = {
            let mut statement = transaction.prepare(
                "SELECT id, code, scope, severity, details FROM health_alerts WHERE status = 'active'",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (health_id, code, scope, severity, details) in &active {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM monitoring_alert_incidents WHERE health_alert_id = ? AND status = 'firing')",
                [health_id],
                |row| row.get(0),
            )?;
            if exists {
                continue;
            }
            let series_key = format!("{code}:{scope}");
            let title = format!("Health: {code}");
            let snapshot = json!({ "code": code, "scope": scope, "details": details });
            let recent_incident: Option<String> = transaction
                .query_row(
                    "SELECT id FROM monitoring_alert_incidents \
                     WHERE source = 'health' AND series_key = ? AND status = 'resolved' \
                       AND resolved_at >= ? \
                     ORDER BY resolved_at DESC LIMIT 1",
                    params![
                        series_key,
                        iso(now_ms.saturating_sub(HEALTH_EPISODE_COOLDOWN_MS))
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(incident_id) = recent_incident {
                transaction.execute(
                    "UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ? \
                     WHERE incident_id = ? AND kind = 'resolved' \
                       AND status IN ('pending', 'retrying')",
                    params![now, incident_id],
                )?;
                transaction.execute(
                    "UPDATE monitoring_alert_incidents SET status = 'firing', health_alert_id = ?, \
                     severity = ?, title = ?, resolved_at = NULL, close_reason = NULL, \
                     rule_snapshot_json = ?, updated_at = ? \
                     WHERE id = ?",
                    params![
                        health_id,
                        severity,
                        title,
                        snapshot.to_string(),
                        now,
                        incident_id
                    ],
                )?;
                add_event_with_details(
                    &transaction,
                    &incident_id,
                    "fired",
                    &json!({ "reopened": true }),
                    &now,
                )?;
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let policy_snapshot = if initialized {
                let setting: Option<String> = transaction
                    .query_row(
                        "SELECT value_json FROM system_settings WHERE key = 'monitoring_health_routing'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()?;
                match setting {
                    Some(setting) => {
                        let setting: StoredHealthRouting = serde_json::from_str(&setting)?;
                        let _revision = setting.revision;
                        let policy_id = if severity == "critical" {
                            setting.critical_policy_id
                        } else {
                            setting.warning_policy_id
                        };
                        policy_id
                            .as_deref()
                            .map(|policy_id| snapshot_policy_id(&transaction, policy_id))
                            .transpose()?
                            .flatten()
                    }
                    None => None,
                }
            } else {
                None
            };
            transaction.execute(
                "INSERT INTO monitoring_alert_incidents(\
                   id, source, health_alert_id, series_key, status, severity, title, firing_at, read_at, \
                   rule_snapshot_json, policy_snapshot_json, created_at, updated_at\
                 ) VALUES (?, 'health', ?, ?, 'firing', ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    health_id,
                    series_key,
                    severity,
                    title,
                    now,
                    if initialized {
                        None::<String>
                    } else {
                        Some(now.clone())
                    },
                    snapshot.to_string(),
                    policy_snapshot,
                    now,
                    now
                ],
            )?;
            if initialized {
                add_event(&transaction, &id, "fired", &now)?;
            } else {
                add_event_with_details(
                    &transaction,
                    &id,
                    "fired",
                    &json!({ "imported": true }),
                    &now,
                )?;
            }
        }
        let resolved = {
            let mut statement = transaction.prepare(
                "SELECT id, title FROM monitoring_alert_incidents \
                 WHERE source = 'health' AND status = 'firing' AND health_alert_id NOT IN (\
                   SELECT id FROM health_alerts WHERE status = 'active'\
                 )",
            )?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (incident_id, title) in resolved {
            transaction.execute(
                "UPDATE monitoring_alert_incidents SET status = 'resolved', resolved_at = ?, \
                 close_reason = 'health_resolved', updated_at = ? WHERE id = ?",
                params![now, now, incident_id],
            )?;
            add_event(&transaction, &incident_id, "recovered", &now)?;
            queue_resolved_delivery(&transaction, &incident_id, &title, &now)?;
        }
        transaction.execute(
            "UPDATE monitoring_alerter_state SET health_initialized = 1, updated_at = ? WHERE id = 1",
            [&now],
        )?;
        transaction.commit()?;
        Ok(())
    }
}
