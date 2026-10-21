#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedSession {
    pub name: String,
    pub attached: u32,
    pub detached_at_ms: u64,
    pub persistent: bool,
}

pub fn eviction_candidate(sessions: &[ManagedSession]) -> Option<&ManagedSession> {
    sessions
        .iter()
        .filter(|session| {
            !session.persistent && session.attached == 0 && session.detached_at_ms > 0
        })
        .min_by_key(|session| session.detached_at_ms)
}

pub fn should_reap(session: &ManagedSession, now_ms: u64, idle_timeout_ms: u64) -> bool {
    !session.persistent
        && session.attached == 0
        && session.detached_at_ms > 0
        && now_ms.saturating_sub(session.detached_at_ms) >= idle_timeout_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> Vec<ManagedSession> {
        vec![
            ManagedSession {
                name: "persistent".to_owned(),
                attached: 0,
                detached_at_ms: 1,
                persistent: true,
            },
            ManagedSession {
                name: "attached".to_owned(),
                attached: 1,
                detached_at_ms: 2,
                persistent: false,
            },
            ManagedSession {
                name: "newer".to_owned(),
                attached: 0,
                detached_at_ms: 20,
                persistent: false,
            },
            ManagedSession {
                name: "older".to_owned(),
                attached: 0,
                detached_at_ms: 10,
                persistent: false,
            },
        ]
    }

    #[test]
    fn evicts_only_the_oldest_detached_non_persistent_session() {
        assert_eq!(eviction_candidate(&sessions()).unwrap().name, "older");
        assert!(eviction_candidate(&sessions()[..2]).is_none());
    }

    #[test]
    fn reaps_only_expired_detached_non_persistent_sessions() {
        let sessions = sessions();
        assert!(!should_reap(&sessions[0], 100, 10));
        assert!(!should_reap(&sessions[1], 100, 10));
        assert!(!should_reap(&sessions[2], 25, 10));
        assert!(should_reap(&sessions[2], 30, 10));
    }
}
