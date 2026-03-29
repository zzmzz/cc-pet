<p align="center">
  <img src="src-tauri/app-icon.png" width="120" alt="CC Pet Logo" />
</p>

<h1 align="center">CC Pet</h1>

<p align="center">
  一个本地桌面宠物聊天客户端，通过 Bridge WebSocket 协议直连
  <a href="https://github.com/chenhg5/cc-connect">cc-connect</a>，
  支持多会话、流式状态感知、按钮确认交互与文件收发。
</p>

## 主要功能

- **桌面宠物交互**：双击宠物打开聊天，右键弹出菜单（聊天/设置/隐藏/退出）。
- **多连接多会话**：支持多个 Bridge 连接，会话可切换、删除、保留本地标题。
- **状态可视化**：会话状态支持 `空闲 / 思考中 / 处理中 / 待确认 / 已完成 / 失败 / 可能卡住`。
- **按钮确认交互**：当服务端返回 `buttons` 时，界面展示多按钮，并支持“自定义输入”作为最后选项。
- **消息体验完善**：Markdown 渲染、代码高亮、链接预览、附件上传与下载。
- **历史持久化**：消息与会话缓存到本地 SQLite，重启后可恢复。
- **可配置能力**：聊天窗透明度、窗口大小、全局快捷键、超时策略（0=不超时）、自定义宠物素材。
- **可选 SSH 跳板**：支持通过 SSH Tunnel 映射到远端 cc-connect。

## 功能示例图片

### 宠物状态示例

| 空闲 | 思考中 | 说话中 | 开心 | 错误 |
|:----:|:------:|:------:|:----:|:----:|
| ![idle](src/assets/pet/idle.png) | ![thinking](src/assets/pet/thinking.png) | ![talking](src/assets/pet/talking.png) | ![happy](src/assets/pet/happy.png) | ![error](src/assets/pet/error.png) |

> 如果你希望 README 再补“聊天窗口/按钮确认”的真实截图，可以直接把图片放到 `docs/images/`，并在此处追加引用。

## 架构概览

```text
本地电脑                                 远程/本地服务器
┌───────────────────────┐  WebSocket   ┌──────────────────────┐
│ CC Pet (Tauri + React)│ ───────────> │ cc-connect (Bridge)  │
│ - 宠物 UI             │ <─────────── │ - 会话/路由/能力协商  │
│ - 聊天窗口            │   事件流      │ - Claude Code 等      │
│ - 状态机与持久化      │               └──────────────────────┘
└───────────────────────┘
```

## 安装（推荐）

前往 [Releases](https://github.com/zzmzz/cc-pet/releases/latest) 下载对应平台安装包：

| 平台 | 文件 |
|------|------|
| Windows | `cc-pet_x.x.x_x64-setup.exe` 或 `.msi` |
| macOS (Apple Silicon) | `cc-pet_x.x.x_aarch64.dmg` |
| macOS (Intel) | `cc-pet_x.x.x_x64.dmg` |
| Linux (Debian/Ubuntu) | `cc-pet_x.x.x_amd64.deb` |
| Linux (通用) | `cc-pet_x.x.x_amd64.AppImage` |

## 前置条件

1. `cc-connect` 已启用 Bridge（v1.2+）：

```toml
[bridge]
enabled = true
port = 9810
token = "a-strong-random-secret"
```

2. 开发环境（源码运行时）：
   - Node.js 18+
   - Rust 1.70+

## 快速开始（源码）

```bash
git clone https://github.com/zzmzz/cc-pet.git
cd cc-pet
npm install
npm run tauri dev
```

首次运行会创建配置文件 `~/.cc-pet/config.toml`，也可在应用设置页直接维护 Bridge 配置。

## 常用操作

| 操作 | 结果 |
|------|------|
| 双击宠物 | 打开/关闭聊天窗口 |
| 右键宠物 | 打开快捷菜单 |
| `Enter` | 发送消息 |
| `Shift+Enter` | 输入换行 |
| `📎 文件` | 上传附件 |
| 会话下拉 | 切换会话、查看状态、管理未读 |

## 开发与测试

```bash
# 前端测试
npm run test:run

# Rust Bridge 相关测试
cargo test --manifest-path src-tauri/Cargo.toml bridge::
```

## 构建发布包

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/`。

## 技术栈

- **桌面框架**：Tauri v2
- **前端**：React + TypeScript + Tailwind CSS + Framer Motion
- **后端**：Rust（Bridge 通信、历史存储、系统能力）
- **数据存储**：SQLite（本地历史与会话缓存）

## License

MIT
