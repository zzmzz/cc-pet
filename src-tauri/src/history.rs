use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub connection_id: String,
    pub role: String,
    pub content: String,
    pub content_type: String,
    pub file_path: Option<String>,
    pub timestamp: f64,
}

pub struct ChatHistory {
    conn: Mutex<Connection>,
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
            conn: Mutex::new(conn),
        })
    }

    /// In-memory store for unit tests (no disk I/O).
    #[cfg(test)]
    fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn add(&self, msg: &ChatMessage) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, connection_id, role, content, content_type, file_path, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg.id,
                msg.connection_id,
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

    pub fn recent(
        &self,
        connection_id: &str,
        limit: u32,
        before_id: Option<&str>,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut msgs = if let Some(bid) = before_id {
            let ts: f64 = conn
                .query_row(
                    "SELECT timestamp FROM messages WHERE id = ?1 AND connection_id = ?2",
                    params![bid, connection_id],
                    |r| r.get(0),
                )
                .unwrap_or(f64::MAX);
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, role, content, content_type, file_path, timestamp FROM messages WHERE connection_id = ?1 AND timestamp < ?2 ORDER BY timestamp DESC LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![connection_id, ts, limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        role: r.get(2)?,
                        content: r.get(3)?,
                        content_type: r.get(4)?,
                        file_path: r.get(5)?,
                        timestamp: r.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            rows
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, role, content, content_type, file_path, timestamp FROM messages WHERE connection_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![connection_id, limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        role: r.get(2)?,
                        content: r.get(3)?,
                        content_type: r.get(4)?,
                        file_path: r.get(5)?,
                        timestamp: r.get(6)?,
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

    pub fn clear(&self, connection_id: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
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
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            file_path TEXT,
            timestamp REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_conn_ts ON messages(connection_id, timestamp DESC);",
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("PRAGMA table_info(messages)")
        .map_err(|e| e.to_string())?;
    let mut has_connection_id = false;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in rows {
        if col.map_err(|e| e.to_string())? == "connection_id" {
            has_connection_id = true;
            break;
        }
    }

    if !has_connection_id {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN connection_id TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conn_ts ON messages(connection_id, timestamp DESC)",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_msg(id: &str, connection_id: &str, ts: f64) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            connection_id: connection_id.into(),
            role: "user".into(),
            content: format!("c-{id}"),
            content_type: "text".into(),
            file_path: None,
            timestamp: ts,
        }
    }

    #[test]
    fn add_and_recent_without_before_id_is_chronological() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("a", "c1", 1.0)).unwrap();
        h.add(&sample_msg("b", "c1", 2.0)).unwrap();
        h.add(&sample_msg("c", "c1", 3.0)).unwrap();
        let got = h.recent("c1", 10, None).unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].id, "a");
        assert_eq!(got[1].id, "b");
        assert_eq!(got[2].id, "c");
    }

    #[test]
    fn recent_with_before_id_pages_by_timestamp_boundary() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("m1", "c1", 10.0)).unwrap();
        h.add(&sample_msg("m2", "c1", 20.0)).unwrap();
        h.add(&sample_msg("m3", "c1", 30.0)).unwrap();
        let page = h.recent("c1", 10, Some("m3")).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, "m1");
        assert_eq!(page[1].id, "m2");
    }

    #[test]
    fn clear_some_deletes_only_that_connection() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("x", "conn-a", 1.0)).unwrap();
        h.add(&sample_msg("y", "conn-b", 2.0)).unwrap();
        h.clear(Some("conn-a")).unwrap();
        assert_eq!(h.recent("conn-a", 10, None).unwrap().len(), 0);
        assert_eq!(h.recent("conn-b", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn clear_none_deletes_all_connections() {
        let h = ChatHistory::new_in_memory().unwrap();
        h.add(&sample_msg("x", "c1", 1.0)).unwrap();
        h.add(&sample_msg("y", "c2", 2.0)).unwrap();
        h.clear(None).unwrap();
        assert_eq!(h.recent("c1", 10, None).unwrap().len(), 0);
        assert_eq!(h.recent("c2", 10, None).unwrap().len(), 0);
    }
}
