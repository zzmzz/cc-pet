use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
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

    pub fn add(&self, msg: &ChatMessage) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, role, content, content_type, file_path, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![msg.id, msg.role, msg.content, msg.content_type, msg.file_path, msg.timestamp],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn recent(&self, limit: u32, before_id: Option<&str>) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut msgs = if let Some(bid) = before_id {
            let ts: f64 = conn
                .query_row("SELECT timestamp FROM messages WHERE id = ?1", params![bid], |r| r.get(0))
                .unwrap_or(f64::MAX);
            let mut stmt = conn
                .prepare(
                    "SELECT id, role, content, content_type, file_path, timestamp FROM messages WHERE timestamp < ?1 ORDER BY timestamp DESC LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![ts, limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        role: r.get(1)?,
                        content: r.get(2)?,
                        content_type: r.get(3)?,
                        file_path: r.get(4)?,
                        timestamp: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            rows
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, role, content, content_type, file_path, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit], |r| {
                    Ok(ChatMessage {
                        id: r.get(0)?,
                        role: r.get(1)?,
                        content: r.get(2)?,
                        content_type: r.get(3)?,
                        file_path: r.get(4)?,
                        timestamp: r.get(5)?,
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

    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            file_path TEXT,
            timestamp REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp DESC);",
    )
    .map_err(|e| e.to_string())
}
