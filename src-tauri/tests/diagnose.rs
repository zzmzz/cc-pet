use cc_pet_lib::history::ChatHistory;

#[tokio::test]
async fn diagnose_real_db() {
    let db_path = dirs::home_dir().unwrap().join(".cc-pet").join("history.db");
    eprintln!("=== DB path: {} ===", db_path.display());
    assert!(db_path.exists(), "DB file does not exist");

    let h = ChatHistory::open(&db_path).unwrap();

    let (tables, distinct_conns) = {
        let conn = h.raw_conn().lock().await;

        let tables: Vec<String> = {
            let mut s = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        eprintln!("Tables: {:?}", tables);

        if tables.contains(&"sessions".to_string()) {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
            eprintln!("sessions table: {} rows", count);
            let mut s = conn.prepare("SELECT id, connection_id, name, active FROM sessions").unwrap();
            let rows: Vec<(String, String, String, bool)> = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap().filter_map(|r| r.ok()).collect();
            for (id, cid, name, active) in &rows {
                eprintln!("  session: id={}, conn={}, name={:?}, active={}", id, cid, name, active);
            }
        } else {
            eprintln!("!!! NO sessions table !!!");
        }

        let msg_count: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        eprintln!("messages table: {} total rows", msg_count);

        {
            let mut s = conn.prepare(
                "SELECT connection_id, session_key, COUNT(*), MAX(timestamp), MIN(timestamp) FROM messages GROUP BY connection_id, session_key"
            ).unwrap();
            let stats: Vec<(String, String, i64, f64, f64)> = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .unwrap().filter_map(|r| r.ok()).collect();
            for (cid, sk, cnt, max_ts, min_ts) in &stats {
                eprintln!("  conn={}, session_key={}, msgs={}, ts_range=[{} .. {}]", cid, sk, cnt, min_ts, max_ts);
            }
        }

        let distinct_conns: Vec<String> = if tables.contains(&"sessions".to_string()) {
            let mut s = conn.prepare("SELECT DISTINCT connection_id FROM sessions").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        } else {
            vec![]
        };

        (tables, distinct_conns)
    };

    eprintln!("--- load_sessions API test ---");
    for cid in &distinct_conns {
        let sessions = h.load_sessions(cid).await.unwrap();
        eprintln!("load_sessions({:?}): {} sessions", cid, sessions.len());
        for s in &sessions {
            eprintln!("  id={}, name={:?}, active={}, last_active_at={:?}", s.id, s.name, s.active, s.last_active_at);
        }
    }

    // Also test with connection_ids from messages (in case sessions table is empty)
    if tables.contains(&"sessions".to_string()) {
        let conn = h.raw_conn().lock().await;
        let msg_conns: Vec<String> = {
            let mut s = conn.prepare("SELECT DISTINCT connection_id FROM messages").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        drop(conn);
        for cid in msg_conns {
            if !distinct_conns.contains(&cid) {
                let sessions = h.load_sessions(&cid).await.unwrap();
                eprintln!("load_sessions({:?}) [from messages only]: {} sessions", cid, sessions.len());
            }
        }
    }

    eprintln!("=== Done ===");
}
