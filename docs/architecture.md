# Agent OS 架构设计文档

> 版本：v0.1（对应代码当前状态）
> 定位：本项目的定盘星文档。后续开发必须符合本文约定的设计原则；
> 若原则需要变更，先改文档再改代码。

---

## 1. 项目定位

**一句话定义**：Agent OS 是一个以"飞书话题群聊"为唯一交互界面、以本地服务为核心、可编排多个 Coding Agent 的个人开发团队操作系统。

**三层架构**：

```
┌─────────────────────────────────────────────┐
│  可视化层：飞书话题群聊                        │
│  · 话题 = 会话边界（用户零学习成本）            │
│  · 卡片 = 任务仪表盘（进度/终态/最近进展）       │
└──────────────────┬──────────────────────────┘
                   │ WS 长连接 / REST
┌──────────────────▼──────────────────────────┐
│  传输层：机器人 Bot（当前为飞书适配器）          │
│  · 消息归一化（text/post/image/file → 统一形状）│
│  · 富媒体本地化（图片/文件落盘 data/downloads/） │
│  · 卡片发送/更新/回复/下载 等原子能力            │
└──────────────────┬──────────────────────────┘
                   │ 回调 onMessage(bot)
┌──────────────────▼──────────────────────────┐
│  核心层：本地服务（真正干活的地方）              │
│  · 会话管理：话题 → 会话 的映射与状态机          │
│  · 全局会话仓库：元数据持久化 + 崩溃恢复          │
│  · 命令解析：/status /close /help              │
│  · 执行引擎：⚠️ 当前为模拟任务，待接真 Agent     │
└─────────────────────────────────────────────┘
```

**关键认知**：飞书只是远程操控端（窗户），本地服务是唯一真相源（大脑）。飞书断线可重连，本地状态不允许损坏。

---

## 2. 核心设计思想

### 2.1 话题即会话 —— 零显式管理的上下文边界

用户不需要"创建会话"。飞书话题本身就是会话的天然边界：

```ts
// src/core/session-manager.ts
function topicIdOf(message: MessageAddress): string {
    return message.threadId || message.rootId || message.messageId;
}
function sessionKey(chatId: string, threadId: string): string {
    return `${chatId}:${threadId}`;
}
```

- 一个话题 = 一个独立上下文，自动定位、自动复用、自动隔离；
- 会话以 `chatId:threadId` 寻址，同一话题内的消息共享同一会话；
- 聊天工具已经帮用户做好了会话分组的 UX，本地服务只做结构映射。

**约定**：任何新功能不得引入"用户手动创建/命名会话"的交互，会话边界只来自 IM 结构。

### 2.2 状态机即并发锁 —— 显式生命周期换安全

会话状态是显式状态机，不是靠布尔变量凑合：

```ts
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
    creating: ["active", "closed"],
    active: ["idle", "closed"],
    idle: ["active", "closed"],
    closed: [],
};
```

```
        ┌──────────┐
        │ creating │ ──────┐
        └────┬─────┘       │
             │             ▼
             │          ┌────────┐
             ├────────► │ active │ ◄──┐
             │          └───┬────┘    │
             │              │         │
             │   ┌──────────▼──┐   ┌──┴────┐
             └──►│    idle     │──►│ closed │
                 └─────────────┘   └───────┘
```

设计收益：
- `active` 时拒绝新任务 → 同一话题天然防重入，不会并发跑两个任务；
- `closed` 后引导用户新开话题 → 会话生死由用户掌控；
- 所有状态迁移必须走 `transition()`，非法迁移直接抛错 → 状态一致性由架构保证，不依赖业务代码自觉；
- 状态与"运行中的任务"（`activeRuns` Map）分离管理，任务可被 AbortController 独立取消。

**约定**：新会话类型若需要更多状态，必须先扩展状态机与转移表，禁止绕过 `transition()` 直接改状态。

### 2.3 一切可恢复 —— 本地是唯一真相源

- **崩溃恢复**：启动时把遗留的 `creating/active` 会话强制恢复为 `idle`
  （`recoverInterruptedSession`），服务重启 = 遗留任务全部回到可重跑状态；
- **原子持久化**：JSON 写入走 `tmp 文件 + rename`，写队列串行化，任何时刻磁盘上都不会出现半截文件；
- **主动取消**：`AbortController` + `activeRuns`，`/close` 能真正掐断后台任务（含节流卡片更新器）。

**约定**：任何新的持久化内容（消息历史、Agent 配置、执行日志）必须沿用"原子写 + 可恢复"原则。

### 2.4 薄传输层 + 厚核心 —— 适配器思想

```ts
// src/im/lark.ts —— 纯适配器
startBot({
    appId, appSecret,
    onMessage: async (msg, bot) => { ... }
});
```

- 传输层把飞书各种消息类型（text/post/image/file）归一化成统一 `IncomingMessage`；
- 把 `@_user_N` 占位符还原成可读的 `@显示名`（`resolveMentions`）；
- 把富媒体下载为本地文件（`downloadResource` → `data/downloads/`）；
- 核心业务（session-manager / 未来的 agent 编排）完全不知道飞书存在，只面对干净的回调接口。

推论：
- 将来换 IM（钉钉/企微）或新增通道，核心层零改动；
- 富媒体本地化是 agent 时代的必要能力——模型不能直接消费飞书云上的文件。

**约定**：核心层禁止 import `@larksuiteoapi/node-sdk`；所有 IM 依赖只允许出现在 `src/im/`。

### 2.5 卡片即远程仪表盘 —— 无头服务的可视化层

`ThrottledCardUpdater` 以 2 秒窗口合并高频更新，本质是**把内部高频状态压缩成低频网络交互**：

```
push() ──► 2s 窗口内只保留最新一张 ──► updateCard(网络请求)
```

卡片承载：进度条 + 状态标签 + 当前步骤 + 最近进展 + 终态（成功/失败）。卡片是本地无头进程的"屏幕"，回答了"agent 干活时用户看什么"的问题。

**约定**：任何耗时超过数秒的后台任务，必须先回卡片再干活，事件回调尽快返回（不阻塞飞书连接）。

### 2.6 整体隐喻：单机操作系统

| 概念 | 实现 | 状态 |
|---|---|---|
| 进程 | Session（话题=进程，状态机=进程状态） | ✅ |
| 终端窗口 | 飞书话题 | ✅ |
| 系统调用 | `/status` `/close` `/help` 斜杠命令 | ✅ |
| 进程输出 | 可刷新的任务卡片 | ✅ |
| 文件系统 | `data/`（sessions.json + downloads/） | ✅ |
| 崩溃恢复 | 重启扫描 + 状态回退 | ✅ |
| **CPU（执行引擎）** | 模拟任务（DEMO_STEPS） | ⚠️ 待接入真 Agent |

骨架按 OS 设计，CPU 尚未接入——这是当前阶段最核心的缺口。

---

## 3. 模块职责与依赖规则

```
src/
├── index.ts                # 入口：装配一切 + 消息路由（编排层雏形）
├── core/                   # 核心层（禁止依赖 im/ 与第三方 SDK）
│   ├── session-manager.ts  # 会话解析、状态机、迁移
│   ├── session-store.ts    # 持久化抽象 + JSON 实现
│   └── command-parser.ts   # 斜杠命令解析（纯函数）
└── im/                     # 传输层（允许依赖飞书 SDK）
    ├── lark.ts             # Bot 适配器：WS 收 + REST 回
    ├── message-parser.ts   # 消息归一化：文本/提及/资源抽取
    └── card.ts             # 卡片构建 + 节流更新器
```

依赖方向（单向）：`index.ts → core/`、`index.ts → im/`。`core/` 不得依赖 `im/`。

### 3.1 传输层 `im/`

| 能力 | 说明 |
|---|---|
| `reply` | 回文本消息（可指定是否回复进话题） |
| `replyCard` | 回一张交互卡片，返回 message_id 供后续更新 |
| `updateCard` | 用新内容原地更新同一张卡片 |
| `downloadResource` | 按 file_key 下载图片/文件到本地，自动推断扩展名 |
| WS 长连接 | 事件分发 `im.message.receive_v1` → 归一化 → 回调 |

### 3.2 核心层 `core/`

**SessionManager**（内存态 + 派生自持久化）
- `resolve(message)`：话题寻址，命中即复用，未命中则新建（`creating`）并持久化；
- `transition(id, next)`：受状态机约束的状态迁移，迁移后立即持久化（失败回滚内存态）；
- `open()`：从 Store 恢复全部会话。

**SessionStore**（抽象接口，可替换实现）
- 当前实现 `JsonSessionStore`：原子写、写队列、zod 校验、坏行清理、启动恢复；
- 接口留了缝：未来可换 SQLite / 文件分片。

---

## 4. 数据模型

### 4.1 Session（会话）

```ts
interface Session {
    id: string;        // UUID
    threadId: string;  // 话题（rootId/messageId 兜底）
    chatId: string;    // 群/单聊 id
    cliId: "claude";   // ⚠️ 预留缝：将来接多 Agent 时的执行引擎标识
    status: "creating" | "active" | "idle" | "closed";
    createdAt: string; // ISO
    updatedAt: string;
}
```

持久化位置：`data/sessions.json`。

### 4.2 IncomingMessage（归一化消息）

```ts
interface IncomingMessage {
    messageId: string;
    chatId: string;
    chatType: string;      // group / p2p
    messageType: string;   // text / post / image / file ...
    text: string;          // 归一化后的纯文本
    rootId: string;        // 回复的根消息
    threadId: string;      // 所属话题
    senderOpenId: string;
    mentions: Mention[];   // { key, name, openId }
    rawContent: string;    // 飞书原始 content JSON（资源抽取用）
}
```

### 4.3 data/ 目录约定

```
data/
├── sessions.json          # 全局会话元数据（原子写）
└── downloads/             # 富媒体本地化产物（file_key.ext）
```

---

## 5. 关键机制

### 5.1 消息处理流水线

```
收到事件 → 归一化 IncomingMessage
        → 记录日志（chat/thread/sender/原文/还原文本/mentions）
        → sessions.resolve() 定位或新建会话
        → parseCommand() 解析命令
        │   ├─ 系统命令（/status /close /help）→ 直接响应
        │   └─ 普通任务
        │       ├─ 会话状态守卫（closed/creating/active 各自分支）
        │       ├─ transition(active) + 注册 AbortController
        │       ├─ 富媒体下载（若有）
        │       ├─ replyCard() 先回一张 running 卡片
        │       └─ 后台执行任务（回调尽快返回）
        └─ 任务结束：updateCard(终态) + transition(idle)
```

### 5.2 并发与取消

- 并发保护：状态机（active 拒绝新任务）+ `activeRuns`（记录在跑任务）；
- 取消：`/close` → `activeRuns.abort()` → 任务内 `wait()` 检测到 abort 返回 false → 取消卡片更新器 → 状态迁移 closed。

### 5.3 崩溃恢复时序

```
进程启动 → SessionManager.open()
        → Store.load()
        → zod 校验每行（坏行剔除并回写清理）
        → creating/active 强制恢复为 idle（回写）
        → 内存恢复全部会话，服务可用
```

---

## 6. 演进路线（待办，按依赖顺序）

> 现状：基础设施（可视化 + 传输 + 会话骨架）完成，执行引擎为模拟实现。

### P0 执行引擎（真 Agent）

1. **AgentProfile 抽象**：`{ id, 名字/身份, cli 启动命令, 默认 cwd, model, skills, tools, mcp }`；
2. **Agent 运行时**：`spawn` 启动 CLI agent（如 `pi`），每个会话独立工作目录，靠目录保活会话上下文；
3. **输出接入卡片**：解析 agent stdout/事件（tool call / progress / 完成）驱动 `ThrottledCardUpdater`，替换 `runCardDemo`。

### P1 编排层（多 Bot 身份）

4. **Agent 注册表**：多个 AgentProfile 并存，各自身份/配置；
5. **命令路由**：`/agent <name> <任务>` 分发到指定 Agent；session 记录 `agentId + cwd`。

### P2 记忆与上下文

6. **消息历史持久化**：每轮问答落盘（复用原子写原则），作为 agent 上下文补充；
7. **会话恢复**：重启后 agent 可按 `agentId + cwd + 历史` 恢复上下文。

### P3 可观测性

8. 任务执行日志落盘（`data/logs/`）、卡片失败重试、多终端会话（临时任务不占话题）。

---

## 7. 术语表

| 术语 | 含义 |
|---|---|
| 话题（thread） | 飞书话题/根消息/消息，会话的寻址基础 |
| 会话（session） | 一次持续性对话，对应一个话题，有状态机 |
| 传输层 | IM 适配器，归一化消息与提供回复能力 |
| 核心层 | 会话管理、编排、执行，不感知 IM |
| 卡片 | 本地任务的远程仪表盘（进度/终态） |
| cliId | 执行引擎标识（现为占位 `claude`） |
