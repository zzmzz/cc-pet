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
        CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp DESC);",
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
