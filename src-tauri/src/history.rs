use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub connection_id: String,
    pub session_key: String,
    pub role: String,
    pub content: String,
    pub content_type: String,
    pub file_path: Option<String>,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSession {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub active: bool,
    pub last_active_at: Option<f64>,
}

fn is_generic_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    n.is_empty() || n == "default" || n == "新会话" || n == "new session" || n == "new chat"
}

pub struct ChatHistory {
    conn: Arc<Mutex<Connection>>,
}

impl Clone for ChatHistory {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
        }
    }
}

impl ChatHistory {
    pub fn new() -> Result<Self, String> {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cc-pet");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("history.db");
        let conn = match Connection::open(&db_path) {
            Ok(conn) => conn,
            Err(err) => {
                eprintln!(
                    "failed to open history db at {}: {err}; falling back to in-memory history",
                    db_path.display()
                );
                Connection::open_in_memory().map_err(|e| e.to_string())?
            }
        };
        init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Expose the raw connection for diagnostic queries.
    pub fn raw_conn(&self) -> &Arc<Mutex<Connection>> {
        &self.conn
    }

    /// Open a DB at a specific path (for testing / custom locations).
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store for unit tests (no disk I/O).
    #[cfg(test)]
    fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn add(&self, msg: &ChatMessage) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, connection_id, session_key, role, content, content_type, file_path, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                msg.connection_id,
                msg.session_key,
                msg.role,
                msg.content,
                msg.content_type,
                msg.file_path,
                msg.timestamp
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn recent(
        &self,
        connection_id: &str,
        session_key: Option<&str>,
        limit: u32,
        before_id: Option<&str>,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().await;
        let sk = session_key.unwrap_or_default();
        let mut msgs = if let Some(bid) = before_id {
            let ts: f64 = conn
                .query_row(
                    "SELECT timestamp FROM messages WHERE id = ?1 AND connection_id = ?2 AND session_key = ?3",
                    params![bid, connection_id, sk],
                    |r| r.get(0),
                )
                .unwrap_or(f64::MAX);
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, session_key, role, content, content_type, file_path, timestamp FROM messages WHERE connection_id = ?1 AND session_key = ?2 AND timestamp < ?3 ORDER BY timestamp DESC LIMIT ?4",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![connection_id, sk, ts, limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        session_key: r.get(2)?,
                        role: r.get(3)?,
                        content: r.get(4)?,
                        content_type: r.get(5)?,
                        file_path: r.get(6)?,
                        timestamp: r.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            rows
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, session_key, role, content, content_type, file_path, timestamp FROM messages WHERE connection_id = ?1 AND session_key = ?2 ORDER BY timestamp DESC LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![connection_id, sk, limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        session_key: r.get(2)?,
                        role: r.get(3)?,
                        content: r.get(4)?,
                        content_type: r.get(5)?,
                        file_path: r.get(6)?,
                        timestamp: r.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            rows
        };
        msgs.reverse();
        Ok(msgs)
    }

    /// Replace the cached session list for a connection with fresh data from Bridge.
    /// Preserves locally-set names (auto-titles) when the Bridge only has a generic name.
    pub async fn save_sessions(
        &self,
        connection_id: &str,
        sessions: &[(String, String)], // (id, name)
        active_session_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;

        // Read existing names so we can preserve auto-titles
        let mut existing_names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, name FROM sessions WHERE connection_id = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![connection_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                existing_names.insert(row.0, row.1);
            }
        }

        conn.execute(
            "DELETE FROM sessions WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("INSERT INTO sessions (id, connection_id, name, active) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;
        for (id, name) in sessions {
            let is_active = active_session_id.map_or(false, |a| a == id);
            // Keep the local name if it's a real title and Bridge only has a generic one
            let final_name = if is_generic_name(name) {
                existing_names.get(id).filter(|n| !is_generic_name(n)).cloned().unwrap_or_else(|| name.clone())
            } else {
                name.clone()
            };
            stmt.execute(params![id, connection_id, final_name, is_active])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Update the display name of a single session in the local cache.
    pub async fn update_session_label(
        &self,
        connection_id: &str,
        session_id: &str,
        label: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE sessions SET name = ?1 WHERE id = ?2 AND connection_id = ?3",
            params![label, session_id, connection_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Load cached sessions for a connection from local DB.
    pub async fn load_sessions(&self, connection_id: &str) -> Result<Vec<LocalSession>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.connection_id, s.name, s.active, m.last_ts \
                 FROM sessions s \
                 LEFT JOIN ( \
                     SELECT session_key, MAX(timestamp) AS last_ts \
                     FROM messages WHERE connection_id = ?1 \
                     GROUP BY session_key \
                 ) m ON m.session_key = s.id \
                 WHERE s.connection_id = ?1 \
                 ORDER BY COALESCE(m.last_ts, 0) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![connection_id], |r| {
                Ok(LocalSession {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    name: r.get(2)?,
                    active: r.get(3)?,
                    last_active_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    }

    pub async fn clear(&self, connection_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().await;
        if let Some(connection_id) = connection_id {
            conn.execute(
                "DELETE FROM messages WHERE connection_id = ?1",
                params![connection_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute("DELETE FROM messages", [])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL DEFAULT '',
            session_key TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            file_path TEXT,
            timestamp REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp DESC);
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, connection_id)
        );",
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("PRAGMA table_info(messages)")
        .map_err(|e| e.to_string())?;
    let mut has_connection_id = false;
    let mut has_session_key = false;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in rows {
        let name = col.map_err(|e| e.to_string())?;
        if name == "connection_id" {
            has_connection_id = true;
        }
        if name == "session_key" {
            has_session_key = true;
        }
    }

    if !has_connection_id {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN connection_id TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    if !has_session_key {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN session_key TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conn_session_ts ON messages(connection_id, session_key, timestamp DESC)",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_msg(id: &str, connection_id: &str, ts: f64) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            connection_id: connection_id.into(),
            session_key: "s-default".into(),
            role: "user".into(),
            content: format!("c-{id}"),
            content_type: "text".into(),
            file_path: None,
            timestamp: ts,
        }
    }

    #[tokio::test]
    async fn add_and_recent_without_before_id_is_chronological() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("a", "c1", 1.0)).await.unwrap();
        h.add(&sample_msg("b", "c1", 2.0)).await.unwrap();
        h.add(&sample_msg("c", "c1", 3.0)).await.unwrap();
        let got = h.recent("c1", Some("s-default"), 10, None).await.unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].id, "a");
        assert_eq!(got[1].id, "b");
        assert_eq!(got[2].id, "c");
    }

    #[tokio::test]
    async fn recent_with_before_id_pages_by_timestamp_boundary() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("m1", "c1", 10.0)).await.unwrap();
        h.add(&sample_msg("m2", "c1", 20.0)).await.unwrap();
        h.add(&sample_msg("m3", "c1", 30.0)).await.unwrap();
        let page = h.recent("c1", Some("s-default"), 10, Some("m3")).await.unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, "m1");
        assert_eq!(page[1].id, "m2");
    }

    #[tokio::test]
    async fn clear_some_deletes_only_that_connection() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("x", "conn-a", 1.0)).await.unwrap();
        h.add(&sample_msg("y", "conn-b", 2.0)).await.unwrap();
        h.clear(Some("conn-a")).await.unwrap();
        assert_eq!(h.recent("conn-a", Some("s-default"), 10, None).await.unwrap().len(), 0);
        assert_eq!(h.recent("conn-b", Some("s-default"), 10, None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn clear_none_deletes_all_connections() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("x", "c1", 1.0)).await.unwrap();
        h.add(&sample_msg("y", "c2", 2.0)).await.unwrap();
        h.clear(None).await.unwrap();
        assert_eq!(h.recent("c1", Some("s-default"), 10, None).await.unwrap().len(), 0);
        assert_eq!(h.recent("c2", Some("s-default"), 10, None).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn save_and_load_sessions_round_trip() {
        let h = ChatHistory::new_in_memory().unwrap();
        let sessions = vec![
            ("s1".to_string(), "Chat A".to_string()),
            ("s2".to_string(), "Chat B".to_string()),
        ];
        h.save_sessions("conn1", &sessions, Some("s2")).await.unwrap();

        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "s1");
        assert_eq!(loaded[0].name, "Chat A");
        assert!(!loaded[0].active);
        assert_eq!(loaded[1].id, "s2");
        assert_eq!(loaded[1].name, "Chat B");
        assert!(loaded[1].active);
    }

    #[tokio::test]
    async fn save_sessions_replaces_previous_data() {
        let h = ChatHistory::new_in_memory().unwrap();
        let v1 = vec![
            ("old1".to_string(), "Old".to_string()),
        ];
        h.save_sessions("conn1", &v1, Some("old1")).await.unwrap();

        let v2 = vec![
            ("new1".to_string(), "New A".to_string()),
            ("new2".to_string(), "New B".to_string()),
        ];
        h.save_sessions("conn1", &v2, Some("new1")).await.unwrap();

        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "new1");
        assert_eq!(loaded[1].id, "new2");
        assert!(loaded.iter().all(|s| s.id != "old1"), "old sessions should be gone");
    }

    #[tokio::test]
    async fn sessions_are_isolated_by_connection() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.save_sessions("c1", &[("a".into(), "A".into())], None).await.unwrap();
        h.save_sessions("c2", &[("b".into(), "B".into())], None).await.unwrap();

        let c1 = h.load_sessions("c1").await.unwrap();
        let c2 = h.load_sessions("c2").await.unwrap();
        assert_eq!(c1.len(), 1);
        assert_eq!(c1[0].id, "a");
        assert_eq!(c2.len(), 1);
        assert_eq!(c2[0].id, "b");
    }

    #[tokio::test]
    async fn load_sessions_returns_empty_for_unknown_connection() {
        let h = ChatHistory::new_in_memory().unwrap();
        let loaded = h.load_sessions("nonexistent").await.unwrap();
        assert!(loaded.is_empty());
    }

    #[tokio::test]
    async fn save_sessions_with_no_active_marks_all_inactive() {
        let h = ChatHistory::new_in_memory().unwrap();
        let sessions = vec![
            ("s1".to_string(), "A".to_string()),
            ("s2".to_string(), "B".to_string()),
        ];
        h.save_sessions("conn1", &sessions, None).await.unwrap();

        let loaded = h.load_sessions("conn1").await.unwrap();
        assert!(loaded.iter().all(|s| !s.active));
    }

    #[tokio::test]
    async fn save_sessions_does_not_affect_messages() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("m1", "conn1", 1.0)).await.unwrap();
        h.save_sessions("conn1", &[("s1".into(), "X".into())], None).await.unwrap();

        let msgs = h.recent("conn1", Some("s-default"), 10, None).await.unwrap();
        assert_eq!(msgs.len(), 1, "messages should be untouched by session save");
    }

    #[tokio::test]
    async fn update_session_label_persists() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.save_sessions("c1", &[("s1".into(), "default".into())], Some("s1"))
            .await
            .unwrap();

        h.update_session_label("c1", "s1", "你好世界").await.unwrap();

        let loaded = h.load_sessions("c1").await.unwrap();
        assert_eq!(loaded[0].name, "你好世界");
    }

    #[tokio::test]
    async fn save_sessions_preserves_local_title_over_generic_bridge_name() {
        let h = ChatHistory::new_in_memory().unwrap();
        // First save with a generic name
        h.save_sessions("c1", &[("s1".into(), "default".into())], Some("s1"))
            .await
            .unwrap();
        // User sends a message → auto-title updates the label locally
        h.update_session_label("c1", "s1", "我的聊天").await.unwrap();

        // Bridge refresh comes in again with generic name "default"
        h.save_sessions("c1", &[("s1".into(), "default".into())], Some("s1"))
            .await
            .unwrap();

        let loaded = h.load_sessions("c1").await.unwrap();
        assert_eq!(loaded[0].name, "我的聊天", "local title should be preserved");
    }

    #[tokio::test]
    async fn save_sessions_uses_bridge_name_when_it_is_meaningful() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.save_sessions("c1", &[("s1".into(), "default".into())], None)
            .await
            .unwrap();

        // Bridge now returns a real name (e.g. user renamed it on Bridge side)
        h.save_sessions("c1", &[("s1".into(), "Bridge Title".into())], None)
            .await
            .unwrap();

        let loaded = h.load_sessions("c1").await.unwrap();
        assert_eq!(loaded[0].name, "Bridge Title");
    }

    #[test]
    fn init_schema_migrates_legacy_table_without_connection_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'text',
                file_path TEXT,
                timestamp REAL NOT NULL
            );
            CREATE INDEX idx_ts ON messages(timestamp DESC);",
        )
        .unwrap();

        let migrated = init_schema(&conn);
        assert!(migrated.is_ok(), "migration should succeed: {migrated:?}");

        let mut stmt = conn.prepare("PRAGMA table_info(messages)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(cols.iter().any(|c| c == "connection_id"));
        assert!(cols.iter().any(|c| c == "session_key"));
    }
}
