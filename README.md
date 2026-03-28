<p align="center">
  <img src="src-tauri/app-icon.png" width="128" />
</p>

<h1 align="center">CC Pet</h1>

<p align="center">桌面宠物，通过 Bridge WebSocket 协议直连 <a href="https://github.com/chenhg5/cc-connect">cc-connect</a>，无需经过 Telegram 等第三方平台。</p>

## 安装

前往 [Releases](https://github.com/zzmzz/cc-pet/releases/latest) 页面，下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| Windows | `cc-pet_x.x.x_x64-setup.exe` 或 `.msi` |
| macOS (Apple Silicon) | `cc-pet_x.x.x_aarch64.dmg` |
| macOS (Intel) | `cc-pet_x.x.x_x64.dmg` |
| Linux (Debian/Ubuntu) | `cc-pet_x.x.x_amd64.deb` |
| Linux (通用) | `cc-pet_x.x.x_amd64.AppImage` |

下载后双击安装，首次运行会自动创建配置文件 `~/.cc-pet/config.toml`，在设置页面填入 Bridge 连接信息即可使用。

## 技术栈

**Tauri v2** + **React** + **Tailwind CSS** + **Framer Motion** + **Rust**

- 宠物：像素风 PNG 素材 + Framer Motion 动画，5 种状态（idle / thinking / talking / happy / error）
- 聊天窗口：Markdown 渲染（react-markdown + react-syntax-highlighter），代码语法高亮
- 历史记录：SQLite 持久化，启动加载，向上滚动分页
- 文件收发：上传附件（base64 经 Bridge 发送）、下载链接
- 配置：始终置顶、窗口透明度、Bridge 连接参数

## 架构

```
本地电脑                              远程/本地服务器
┌──────────────────┐   WebSocket   ┌──────────────────┐
│  CC Pet (Tauri)  │ ────────────→ │   cc-connect     │
│  React + Rust    │ ←──────────── │  Bridge Server   │
│                  │  Bridge协议    │       ↓          │
└──────────────────┘               │  Claude Code等   │
                                   └──────────────────┘
```

## 前置条件

1. cc-connect v1.2+ 且在 `config.toml` 中启用 Bridge：

```toml
[bridge]
enabled = true
port = 9810
token = "a-strong-random-secret"
```

2. Node.js 18+、Rust 1.70+

## 快速开始

```bash
cd cc-pet
npm install
npm run tauri dev
```

首次运行会自动创建 `~/.cc-pet/config.toml`，在设置页面填入 Bridge 连接信息即可。

## 构建

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/` 下。

## 操作方式

| 操作 | 效果 |
|------|------|
| 双击宠物 | 打开/关闭聊天窗口 |
| Enter | 发送消息 |
| Shift+Enter | 换行 |
| 📎 按钮 | 上传文件 |
| 系统托盘 | 打开聊天、设置、退出 |

## 宠物状态

| idle | thinking | talking | happy | error |
|:----:|:--------:|:-------:|:-----:|:-----:|
| ![idle](src/assets/pet/idle.png) | ![thinking](src/assets/pet/thinking.png) | ![talking](src/assets/pet/talking.png) | ![happy](src/assets/pet/happy.png) | ![error](src/assets/pet/error.png) |
| 待机，呼吸动画 | 等待回复，托腮思考 | 收到回复，张嘴说话 | 连接成功，开心欢呼 | 出错，委屈低头 |

## Bridge 单元测试

```bash
# 运行 Rust Bridge 单元测试（URL 编码、消息结构）
cargo test --manifest-path src-tauri/Cargo.toml bridge::
```

## License

MIT
