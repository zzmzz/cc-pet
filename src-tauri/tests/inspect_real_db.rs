//! Diagnostic: inspect the real ~/.cc-pet/history.db to see what's actually in there.

use cc_pet_lib::history::ChatHistory;

#[tokio::test]
async fn inspect_real_db() {
    let db_path = dirs::home_dir()
        .expect("no home dir")
        .join(".cc-pet")
        .join("history.db");

    eprintln!("=== Inspecting real DB at: {} ===", db_path.display());

    if !db_path.exists() {
        eprintln!("DB file does not exist!");
        return;
    }

    let h = ChatHistory::open(&db_path).expect("failed to open real db");

    // Check if sessions table has any data
    let conn_ids = {
        let inner = h.raw_conn().lock().await;
        // List all tables
        let mut stmt = inner
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        eprintln!("Tables in DB: {:?}", tables);

        if !tables.contains(&"sessions".to_string()) {
            eprintln!("!!! sessions table does NOT exist !!!");
            eprintln!("This means the new schema migration hasn't run on the real DB yet.");
            return;
        }

        // Count sessions
        let count: i64 = inner
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        eprintln!("Total rows in sessions table: {}", count);

        // List all sessions
        let mut stmt = inner
            .prepare("SELECT id, connection_id, name, active FROM sessions ORDER BY connection_id, rowid")
            .unwrap();
        let rows: Vec<(String, String, String, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for (id, conn, name, active) in &rows {
            eprintln!(
                "  session: id={}, conn={}, name={:?}, active={}",
                id, conn, name, active
            );
        }

        // List distinct connection_ids from messages
        let mut stmt = inner
            .prepare("SELECT DISTINCT connection_id FROM messages")
            .unwrap();
        let cids: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        eprintln!("Distinct connection_ids in messages: {:?}", cids);

        // List distinct session_keys from messages
        let mut stmt = inner
            .prepare("SELECT DISTINCT session_key FROM messages")
            .unwrap();
        let sks: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        eprintln!("Distinct session_keys in messages: {:?}", sks);

        // Count messages per session_key
        let mut stmt = inner
            .prepare("SELECT connection_id, session_key, COUNT(*) FROM messages GROUP BY connection_id, session_key")
            .unwrap();
        let counts: Vec<(String, String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for (conn, sk, cnt) in &counts {
            eprintln!("  messages: conn={}, session_key={}, count={}", conn, sk, cnt);
        }

        cids
    };

    // Also try loading via the API
    for conn_id in &conn_ids {
        let sessions = h.load_sessions(conn_id).await.unwrap();
        eprintln!(
            "load_sessions({:?}) => {} sessions: {:?}",
            conn_id,
            sessions.len(),
            sessions.iter().map(|s| format!("{}:{}", s.id, s.name)).collect::<Vec<_>>()
        );
    }

    eprintln!("=== Done ===");
}
