# Agent OS

> 个人开发团队的编排系统：飞书话题当控制台，本地服务管会话与编排，Claude Code 当执行引擎。

Agent OS 把「飞书话题群聊」变成你与 AI 开发团队之间的唯一交互界面。在飞书里发一条消息，本地服务调度 CLI 编码 Agent（当前为 Claude Code）真实执行任务，进度通过可刷新卡片实时回传。

```
┌─────────────────────────────────────────────┐
│  可视化层：飞书话题群聊                        │
│  · 话题 = 会话边界（零学习成本）               │
│  · 卡片 = 任务仪表盘（进度/终态/最近进展）      │
└──────────────────┬──────────────────────────┘
                   │ WS 长连接 / REST
┌──────────────────▼──────────────────────────┐
│  传输层：机器人 Bot（飞书适配器）              │
│  · 消息归一化（text/post/image/file）        │
│  · 富媒体本地化（图片/文件落盘）               │
└──────────────────┬──────────────────────────┘
                   │ 回调 onMessage
┌──────────────────▼──────────────────────────┐
│  核心层：本地服务（真正干活的地方）             │
│  · 会话管理：话题 → 会话 映射 + 状态机         │
│  · 全局会话仓库：元数据持久化 + 崩溃恢复        │
│  · CLI 编排：spawn Agent 子进程，流式解析输出  │
└─────────────────────────────────────────────┘
```

## 核心设计思想

- **话题即会话**：飞书话题就是会话边界，自动定位、自动复用、自动隔离，用户零显式管理。
- **状态机即并发锁**：会话状态 `creating → active → idle → closed` 显式状态机，非法转移拒绝，同一话题天然防重入。
- **一切可恢复**：JSON 原子写（tmp + rename）、写队列串行、启动时崩溃恢复——本地是唯一真相源，飞书只是远程操控端。
- **薄传输层 + 厚核心**：IM 适配器与核心层单向依赖，将来换 IM 或加 Bot 身份，核心零改动。
- **卡片即远程仪表盘**：高频进度经 2 秒节流合并，压缩成低频网络交互。

## 功能特性

- ✅ 飞书 WS 长连接收消息，REST 回消息
- ✅ 文本 / 富文本 / 图片 / 文件消息归一化，@提及还原
- ✅ 图片与文件下载到本地 `data/downloads/`
- ✅ 交互卡片发送、原地更新、节流刷新
- ✅ 会话内核：话题寻址、状态机、原子持久化、崩溃恢复
- ✅ CLI 执行引擎：spawn Claude Code、stream-json 事件解析、会话恢复（`--resume`）、超时与取消
- ✅ 任务进度跟踪（工具调用 / 耗时 / 上下文 token）
- 🚧 CLI 流式渲染：进度事件刷到飞书卡片（当前仅控制台日志）
- 🚧 多 Agent 身份编排：AgentProfile（模型 / skills / tools / MCP 差异化配置）
- 🚧 命令路由：`/agent <name> <任务>` 分发到指定 Agent

## 快速开始

### 环境要求

- Node.js >= 22
- pnpm
- Claude Code CLI（`claude` 命令可用）

### 安装与配置

```bash
pnpm install
cp .env.example .env
```

在 `.env` 中填入飞书自建应用凭证：

```bash
BOT_A_APP_ID=cli_xxx
BOT_A_APP_SECRET=xxx
# 可选：Claude Code 的工作目录（默认当前目录）
# CLAUDE_WORKDIR=/path/to/your/project
```

> 需要先在[飞书开放平台](https://open.feishu.cn/)创建自建应用，开通机器人能力、`im.message.receive_v1` 事件订阅（长连接模式）、`im:message` 与 `im:resource` 权限。

### 运行

```bash
pnpm dev        # tsx watch，开发模式
# 或
pnpm start:once # 单次运行
```

启动后，在飞书群里 @ 机器人即可下发任务。

### 命令

| 命令 | 说明 |
|---|---|
| `/status` | 查看当前会话状态、CLI 会话 id |
| `/close` | 关闭当前会话（中止运行中的任务） |
| `/help` | 查看命令列表 |

## 项目结构

```
src/
├── index.ts                # 入口：装配 + 消息路由
├── core/                   # 核心层（禁止依赖 im/ 与第三方 SDK）
│   ├── session-manager.ts  # 会话解析、状态机、迁移
│   ├── session-store.ts    # 持久化抽象 + JSON 原子实现
│   ├── command-parser.ts   # 斜杠命令解析
│   └── task-progress.ts    # CLI 事件 → 进度快照
├── cli/                    # CLI 执行引擎（适配器模式）
│   ├── types.ts            # CliAdapter / CliEvent 类型
│   ├── claude-adapter.ts   # Claude Code stream-json 解析
│   └── runner.ts           # spawn 子进程 + 逐行事件
└── im/                     # 传输层（允许依赖飞书 SDK）
    ├── lark.ts             # Bot 适配器：WS 收 + REST 回
    ├── message-parser.ts   # 消息归一化
    └── card.ts             # 卡片构建 + 节流更新器
```

## 会话模型

```
L1 会话（agent-os 调度层）        L3 会话（CLI 执行层）
┌──────────────────────┐        ┌──────────────────────┐
│ id: uuid             │        │ sessionId: string     │
│ key: chatId:threadId │ ─────► │ JSONL 对话档案          │
│ status: 状态机        │  恢复  │ 按 cwd 组织存储         │
│ cliSessionId: string │ --resume│                       │
└──────────────────────┘        └──────────────────────┘
```

一个飞书话题对应一个 L1 会话；L1 记录当前使用的 CLI 会话 id，任务完成后写回，下次追问用 `--resume` 续聊。

## 文档

- [架构设计文档](docs/architecture.md) —— 设计思想、模块职责、演进路线
- [代码阅读指南](docs/code-reading-guide.md) —— 基于本项目源码的异步编程解读

## 路线图

- [ ] CLI 流式渲染：进度事件 → 飞书卡片
- [ ] AgentProfile：多 Agent 身份（不同模型 / skills / tools / MCP）
- [ ] 命令路由：`/agent <name> <任务>`
- [ ] cwd 归属：话题绑定项目（L1 扩展 cwd + engineSessions）
- [ ] 消息历史持久化（会话上下文补充）
- [ ] 任务执行日志落盘

## 技术栈

TypeScript · Node.js（ESM）· 飞书开放平台 SDK · zod · tsx
