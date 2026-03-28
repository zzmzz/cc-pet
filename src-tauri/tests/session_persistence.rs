//! Integration test: simulates the full session persistence lifecycle
//! using a real temporary SQLite file, including "restart" (close + reopen DB).

use cc_pet_lib::history::ChatHistory;
use std::path::PathBuf;

fn open_db(path: &PathBuf) -> ChatHistory {
    ChatHistory::open(path).expect("failed to open test db")
}

#[tokio::test]
async fn full_lifecycle_save_label_restart_load() {
    // Use a temp file so we get real disk I/O
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("test-history.db");

    // ── Phase 1: First "app launch" ──
    {
        let h = open_db(&db_path);

        // Simulate: Bridge returns 2 sessions with generic names
        let bridge_sessions = vec![
            ("sess-aaa".to_string(), "default".to_string()),
            ("sess-bbb".to_string(), "default".to_string()),
        ];
        h.save_sessions("conn1", &bridge_sessions, Some("sess-aaa"))
            .await
            .unwrap();

        // Verify they're saved
        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(loaded.len(), 2, "should have 2 sessions after save");
        assert_eq!(loaded[0].id, "sess-aaa");
        assert_eq!(loaded[1].id, "sess-bbb");
        assert!(loaded[0].active);
        assert!(!loaded[1].active);

        // Simulate: user sends a message → auto-title fires → update_session_label
        h.update_session_label("conn1", "sess-aaa", "你好世界聊天")
            .await
            .unwrap();
        h.update_session_label("conn1", "sess-bbb", "测试对话")
            .await
            .unwrap();

        // Verify labels are updated
        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(loaded[0].name, "你好世界聊天");
        assert_eq!(loaded[1].name, "测试对话");

        // Simulate: Bridge refresh comes in again with generic names
        let bridge_refresh = vec![
            ("sess-aaa".to_string(), "default".to_string()),
            ("sess-bbb".to_string(), "default".to_string()),
        ];
        h.save_sessions("conn1", &bridge_refresh, Some("sess-bbb"))
            .await
            .unwrap();

        // Labels should be PRESERVED (not overwritten by "default")
        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(
            loaded[0].name, "你好世界聊天",
            "auto-title should survive Bridge refresh"
        );
        assert_eq!(
            loaded[1].name, "测试对话",
            "auto-title should survive Bridge refresh"
        );
        // Active should have switched
        assert!(!loaded[0].active);
        assert!(loaded[1].active);
    }
    // DB handle dropped here — simulates app close

    // ── Phase 2: "App restart" — reopen DB from disk ──
    {
        let h = open_db(&db_path);

        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(loaded.len(), 2, "sessions should survive restart");
        assert_eq!(loaded[0].id, "sess-aaa");
        assert_eq!(loaded[0].name, "你好世界聊天", "label should survive restart");
        assert_eq!(loaded[1].id, "sess-bbb");
        assert_eq!(loaded[1].name, "测试对话", "label should survive restart");
        assert!(!loaded[0].active);
        assert!(loaded[1].active, "active flag should survive restart");
    }

    // ── Phase 3: Verify Bridge can override with a REAL name ──
    {
        let h = open_db(&db_path);

        // Bridge now returns a meaningful name (user renamed on Bridge side)
        let bridge_with_real_name = vec![
            ("sess-aaa".to_string(), "Bridge给的好名字".to_string()),
            ("sess-bbb".to_string(), "default".to_string()),
        ];
        h.save_sessions("conn1", &bridge_with_real_name, Some("sess-aaa"))
            .await
            .unwrap();

        let loaded = h.load_sessions("conn1").await.unwrap();
        assert_eq!(
            loaded[0].name, "Bridge给的好名字",
            "meaningful Bridge name should override local"
        );
        assert_eq!(
            loaded[1].name, "测试对话",
            "local title should be kept when Bridge has generic name"
        );
    }
}

#[tokio::test]
async fn empty_db_returns_no_sessions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("empty.db");

    let h = open_db(&db_path);
    let loaded = h.load_sessions("any-conn").await.unwrap();
    assert!(loaded.is_empty(), "fresh DB should have no sessions");
}

#[tokio::test]
async fn messages_and_sessions_are_independent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("mixed.db");

    let h = open_db(&db_path);

    // Save a message
    h.add(&cc_pet_lib::history::ChatMessage {
        id: "msg-1".into(),
        connection_id: "conn1".into(),
        session_key: "sess-aaa".into(),
        role: "user".into(),
        content: "hello".into(),
        content_type: "text".into(),
        file_path: None,
        timestamp: 1000.0,
    })
    .await
    .unwrap();

    // Save sessions
    h.save_sessions("conn1", &[("sess-aaa".into(), "Chat".into())], Some("sess-aaa"))
        .await
        .unwrap();

    // Both should be independently accessible
    let msgs = h.recent("conn1", Some("sess-aaa"), 10, None).await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "hello");

    let sessions = h.load_sessions("conn1").await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "Chat");

    // Drop and reopen
    drop(h);
    let h2 = open_db(&db_path);

    let msgs = h2.recent("conn1", Some("sess-aaa"), 10, None).await.unwrap();
    assert_eq!(msgs.len(), 1, "messages survive restart");

    let sessions = h2.load_sessions("conn1").await.unwrap();
    assert_eq!(sessions.len(), 1, "sessions survive restart");
    assert_eq!(sessions[0].name, "Chat");
}
