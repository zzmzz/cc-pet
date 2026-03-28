# cc-pet Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reliable unit-test suite for both Rust (`src-tauri`) and frontend (`src`) with minimum behavior changes.

**Architecture:** Implement tests in two layers: first Rust pure-logic modules, then frontend with Vitest + jsdom. Keep production code changes minimal and only for testability boundaries (small extraction or export). Verify each task with explicit red/green test runs before moving forward.

**Tech Stack:** Rust `cargo test`, TypeScript `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `zustand`

---

## File Structure Map

- Create: `vitest.config.ts` (frontend test runner config)
- Create: `src/test/setup.ts` (global test setup and runtime mocks)
- Create: `src/lib/commands.test.ts` (invoke wrapper tests)
- Create: `src/lib/store.test.ts` (zustand store behavior tests)
- Create: `src/components/ChatWindow.test.tsx` (chat interaction tests)
- Create: `src/components/Pet.test.tsx` (pet state render tests)
- Create: `src/components/Settings.test.tsx` (settings save/form tests)
- Modify: `package.json` (add test scripts + deps)
- Modify: `src-tauri/src/config.rs` (module tests, optional minimal extraction)
- Modify: `src-tauri/src/history.rs` (module tests, optional test-only constructor)
- Modify: `src-tauri/src/lib.rs` (tests for pure helper logic if present)
- Modify: `src-tauri/src/bridge.rs` (extend existing tests with edge cases)
- Optional Modify: `README.md` (frontend test command section)

### Task 1: Frontend Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Test: `npm run test:run`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/smoke.test.ts
import { describe, it, expect } from "vitest";

describe("test runtime", () => {
  it("runs with jsdom", () => {
    expect(typeof window).toBe("object");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run`  
Expected: FAIL with "Missing script: test:run" or "Cannot find module 'vitest'"

- [ ] **Step 3: Write minimal implementation**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

```json
// package.json (scripts + devDependencies excerpt)
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run"
  },
  "devDependencies": {
    "vitest": "latest",
    "jsdom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/jest-dom": "latest",
    "@testing-library/user-event": "latest"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/lib/smoke.test.ts`  
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/lib/smoke.test.ts
git commit -m "test: add vitest infrastructure for frontend unit tests"
```

### Task 2: Rust Config + History Unit Tests

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/history.rs`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 1: Write the failing test**

```rust
// config.rs tests (example cases)
#[test]
fn non_empty_filters_blank_values() {
    assert_eq!(non_empty(Some("  ".into())), None);
    assert_eq!(non_empty(Some("abc".into())), Some("abc".into()));
}

#[test]
fn parse_pet_llm_uses_defaults_when_missing() {
    let (pet, llm) = parse_pet_and_llm(None, None);
    assert_eq!(pet.size, 120);
    assert!(!llm.enabled);
}
```

```rust
// history.rs tests (example cases)
#[test]
fn recent_returns_sorted_ascending_after_reverse() {
    // insert 3 messages with timestamp 1,2,3 then recent(limit=3)
    // assert returned order is 1,2,3
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml config::tests::non_empty_filters_blank_values`  
Expected: FAIL with "cannot find function/constructor/test module" before tests are added

- [ ] **Step 3: Write minimal implementation**

```rust
// history.rs test-only helper (if needed)
#[cfg(test)]
impl ChatHistory {
    fn from_connection(conn: Connection) -> Result<Self, String> {
        init_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}
```

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // add deterministic unit tests for non_empty, toml_single_quoted,
    // parse_pet_and_llm defaults, history add/recent/clear behaviors.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: PASS for new `config` and `history` test cases

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/history.rs
git commit -m "test: add config and history unit tests for rust core modules"
```

### Task 3: Extend Existing Bridge/Lib Rust Coverage

**Files:**
- Modify: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn normalize_host_keeps_valid_ipv4_unchanged() {
    assert_eq!(normalize_host("127.0.0.1"), "127.0.0.1");
}

#[test]
fn make_message_contains_expected_content_type() {
    let payload = make_message("hi", &test_cfg());
    assert!(payload.contains("\"type\":\"message\""));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::tests::normalize_host_keeps_valid_ipv4_unchanged`  
Expected: FAIL before adding new assertions/tests

- [ ] **Step 3: Write minimal implementation**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // extend bridge tests with edge cases:
    // - valid host passthrough
    // - unknown message type ignored path (pure helper, no runtime dependency)
    // - message payload shape checks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`  
Expected: PASS for all bridge tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bridge.rs src-tauri/src/lib.rs
git commit -m "test: extend bridge and runtime helper rust unit coverage"
```

### Task 4: `commands.ts` and `store.ts` Unit Tests

**Files:**
- Create: `src/lib/commands.test.ts`
- Create: `src/lib/store.test.ts`
- Test: `npm run test:run -- src/lib/commands.test.ts src/lib/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// commands.test.ts
import { describe, it, expect, vi } from "vitest";
import * as core from "@tauri-apps/api/core";
import { sendMessage, getHistory, clearHistory } from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("commands wrappers", () => {
  it("passes connectionId and text to send_message invoke", async () => {
    await sendMessage("c1", "hello");
    expect(core.invoke).toHaveBeenCalledWith("send_message", { connectionId: "c1", text: "hello" });
  });
});
```

```ts
// store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./store";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));

it("setConnections keeps previous connected states", () => {
  // arrange + assert
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/lib/commands.test.ts src/lib/store.test.ts`  
Expected: FAIL because test files do not exist yet

- [ ] **Step 3: Write minimal implementation**

```ts
// add tests for:
// - commands invoke name + payload mapping
// - getHistory/clearHistory null mapping behavior
// - setConnections default active connection
// - setConnectionStatus recalculates top-level connected flag
// - addMessage/updateMessage/clearMessages paths
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/lib/commands.test.ts src/lib/store.test.ts`  
Expected: PASS with all cases green

- [ ] **Step 5: Commit**

```bash
git add src/lib/commands.test.ts src/lib/store.test.ts
git commit -m "test: cover tauri command wrappers and zustand store transitions"
```

### Task 5: Core React Component Unit Tests

**Files:**
- Create: `src/components/ChatWindow.test.tsx`
- Create: `src/components/Pet.test.tsx`
- Create: `src/components/Settings.test.tsx`
- Test: `npm run test:run -- src/components/*.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { ChatWindow } from "./ChatWindow";

test("renders send input and send button", () => {
  render(<ChatWindow />);
  expect(screen.getByPlaceholderText(/输入/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/components/ChatWindow.test.tsx`  
Expected: FAIL because props/providers/mocks are missing

- [ ] **Step 3: Write minimal implementation**

```tsx
// tests should include:
// - ChatWindow: send action triggers command call (mocked)
// - Pet: renders correct visual state class based on store petState
// - Settings: loads default values and triggers saveConfig with updated values
// use a shared render helper with mocked store + mocked command module
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/components/ChatWindow.test.tsx src/components/Pet.test.tsx src/components/Settings.test.tsx`  
Expected: PASS for core interaction paths

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatWindow.test.tsx src/components/Pet.test.tsx src/components/Settings.test.tsx
git commit -m "test: add component-level unit tests for chat pet and settings"
```

### Task 6: Final Verification + Documentation

**Files:**
- Optional Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Write the failing test**

```text
No new test file in this task; this task validates integrated suite behavior.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: If failures exist, capture failing modules and fix before completion

- [ ] **Step 3: Write minimal implementation**

```md
## 测试

```bash
npm run test:run
cargo test --manifest-path src-tauri/Cargo.toml
```
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: PASS (frontend and rust suites all green)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document frontend and rust unit test commands"
```
