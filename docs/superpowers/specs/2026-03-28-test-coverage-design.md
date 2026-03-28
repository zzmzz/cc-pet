# cc-pet 单元测试补全设计

## 背景与目标

当前仓库仅有少量 Rust 侧测试（`bridge.rs`），前端缺少测试框架与单测。目标是按方案 A 分层推进：先补 Rust 纯逻辑单测，再建立前端 Vitest 基建并补关键逻辑与组件单测，在不改变现有业务行为的前提下提升回归保障能力。

## 范围

### 纳入范围

- Rust 侧：`src-tauri/src/config.rs`、`src-tauri/src/history.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/bridge.rs` 中可稳定测试的纯逻辑/边界分支。
- 前端基建：新增 `vitest` + `jsdom` + Testing Library，补充测试命令与基础配置。
- 前端测试：`src/lib/commands.ts`、`src/lib/store.ts` 以及 `src/components/ChatWindow.tsx`、`src/components/Pet.tsx`、`src/components/Settings.tsx` 的核心行为测试。

### 不纳入范围

- 依赖真实网络、真实 Tauri runtime、真实文件系统副作用的端到端验证。
- 与本次测试补全无关的功能重构和 UI 改版。

## 方案对比与决策

### 方案 A（采用）

先 Rust 后前端，按风险和可测性递进补齐。

- 优点：失败定位清晰，改动分层可控，便于逐步验证。
- 代价：改动文件较多，需要统一整理测试入口。

### 方案 B（未采用）

先一次性搭建前端测试再并行补测。

- 风险：一旦基建配置异常，会阻塞所有新增前端测试。

### 方案 C（未采用）

仅补纯函数，组件测试最小化。

- 风险：交互回归防护不足，不满足“尽可能全覆盖”目标。

## 架构与实现设计

### 1) Rust 测试层

- 在各模块内部使用 `#[cfg(test)]` 和局部测试辅助函数。
- 优先覆盖：配置解析/默认值、历史记录分页边界、桥接消息构造与编码、状态切换纯逻辑。
- 对时间、随机、路径等不稳定输入使用可控测试数据，避免脆弱断言。

### 2) 前端测试基建层

- 新增测试依赖：`vitest`、`jsdom`、`@testing-library/react`、`@testing-library/jest-dom`、`@testing-library/user-event`（若组件交互需要）。
- 新增 `vitest.config` 与 `setupTests`，集中处理 `window`、`matchMedia`、Tauri API mock 等环境准备。
- 在 `package.json` 添加 `test` 与 `test:run`（CI 友好）脚本。

### 3) 前端测试用例层

- `commands.ts`：命令参数转换、错误分支、返回值约定。
- `store.ts`：状态更新、消息追加、历史读取与重置等状态机行为。
- 组件测试：
  - `ChatWindow.tsx`：输入发送、流式消息渲染、错误提示关键路径。
  - `Pet.tsx`：状态到视觉类名/资源映射，核心交互触发。
  - `Settings.tsx`：表单默认值、保存行为、非法输入兜底。

## 错误处理策略

- 对异步测试统一使用 `await` + 显式断言，避免假阳性。
- 对外部依赖统一 mock 并在每个测试后清理，防止测试间污染。
- 对不可稳定断言的字段（如时间戳）采用“存在性 + 类型”断言。

## 验收标准

- Rust 与前端测试均可在本地一键执行。
- 新增测试覆盖本轮改动热点模块并通过全部测试。
- 不引入行为变更；仅为可测试性做最小必要改动。

## 风险与缓解

- 风险：现有代码耦合 Tauri 运行时导致前端测试难隔离。
  - 缓解：通过封装调用层并在测试中统一 mock。
- 风险：历史脏工作区导致断言漂移。
  - 缓解：测试仅断言稳定契约，避免依赖易变实现细节。
- 风险：组件用例过重导致执行慢。
  - 缓解：优先关键路径，复杂场景下沉到 `lib` 层测试。

## 里程碑

1. 完成 Rust 模块测试补齐并通过 `cargo test`。
2. 完成前端 Vitest 基建并通过最小 smoke 测试。
3. 完成 `lib` 与核心组件测试并通过 `npm run test:run`。
4. 回归检查，确认行为未变更并补充 README 测试说明（如有必要）。
