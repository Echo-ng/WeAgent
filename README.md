# WeAgent

Claude Code Windows 桌面客户端，支持通过微信远程对话，并提供对话管理、多 Agent 管理与协作编排。

## 前置条件

- Node.js 20+
- pnpm 9+
- 已安装并登录 [Claude Code CLI](https://code.claude.com/docs/en/setup)
- 微信 PC 版 ≥ 4.1.8.67，已开启 ClawBot 插件（微信渠道功能）

## 开发

```bash
pnpm install
pnpm dev
```

若 Electron 启动报 `Electron uninstall`，请使用国内镜像下载：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
cd node_modules\.pnpm\electron@*\node_modules\electron
node install.js
```

## 构建与打包

### 开发构建（不生成安装包）

```bash
pnpm build
```

### 打包 Windows 安装程序

在项目根目录执行：

```powershell
cd D:\ai\WeAgent

# 国内网络建议先设置镜像（加速 Electron 与打包工具下载）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

pnpm install
pnpm dist
```

或在 `apps/desktop` 目录：

```powershell
cd D:\ai\WeAgent\apps\desktop
pnpm dist
```

### 产物位置

| 文件 | 说明 |
|------|------|
| `apps/desktop/release/WeAgent-Setup-0.1.0.exe` | **NSIS 安装包**（分发给用户） |
| `apps/desktop/release/win-unpacked/` | 免安装绿色版目录，可直接运行 `WeAgent.exe` |

### 安装后说明

- 应用数据（SQLite、微信凭证、Agent 配置）保存在：`%APPDATA%\WeAgent\data\`
- 本机仍需单独安装并登录 **Claude Code CLI**（`claude` 命令可用）
- 微信渠道需在 PC 微信中开启 **ClawBot 插件**

### 常见问题

**打包卡在 downloading electron…**

设置上面的 `ELECTRON_MIRROR` 后重试；或手动下载 Electron  zip 放入缓存目录 `%LOCALAPPDATA%\electron\Cache\`。

**安装后启动报 better-sqlite3 错误**

在 `apps/desktop` 下重新执行：

```powershell
pnpm exec electron-builder install-app-deps
pnpm dist
```

## 架构

- `apps/desktop` — Electron 桌面应用
- `packages/shared` — 共享类型与 StreamEvent 协议
- `packages/core` — 会话、Agent、编排、EventBus
- `packages/claude-bridge` — Claude Code Agent SDK 封装
- `packages/channels-wechat` — 微信 iLink 协议适配
