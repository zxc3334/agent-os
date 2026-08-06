# Agent OS 代码阅读指南

> 写给 owner（非专业程序员）：本指南用本项目真实源码讲解异步编程的核心概念。
> 目标不是"会写"，而是"会看"——能读懂系统怎么流转、能拍板、能把关。
> 每个概念配一个"心法"（一句话模型）+ 源码实例（从简单到复杂）+ 速查表。

---

## 0. 总则：两条心法走天下

1. **await 心法**：await = "点外卖后站着等餐"。要等外部（网络/文件/子进程/另一个异步函数）就必须 await；纯内存计算不用。
2. **传染规则**：函数内部调用了异步函数，它自己就必须是 async——await 像病毒，碰到就得传染。

---

## 1. await：异步的基本心法

### Level 0：等网络响应（`src/im/lark.ts`）

```ts
async reply(messageId, text, replyInThread = false) {
    const res = await client.im.v1.message.reply({ ... });  // 点外卖：发网络请求
    return res.data?.message_id;                            // 等餐：拿到结果才能取 message_id
}
```

- `await` 前：组参数（同步，纯计算）
- `await` 后：**必须拿到 `res` 才能取 `message_id`** → 必须等
- 函数是 `async`：内部用了 await（传染规则）

这个模式项目里到处是：`downloadResource`、`replyCard`、`updateCard`、`SessionManager.persist`。

### Level 1：await 会抛错 —— try/catch 兜底（`src/core/session-store.ts`）

```ts
async load(): Promise<Session[]> {
    let content: string;
    try {
        content = await readFile(this.filePath, "utf8");  // 外卖可能送不到
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];  // 文件不存在=首次启动
        throw error;   // 真故障，继续往上抛
    }
    ...
}
```

**心法：每一个 await 都是"外卖可能送不到"，你决定：这次送不到怎么办？**
- 不算错 → 捕获后返回默认值
- 真出错 → 捕获后 `throw` 上抛，让上层决定

### Level 2：await 保证顺序，失败要回滚（`src/core/session-manager.ts`）

```ts
async resolve(message: MessageAddress): Promise<ResolvedSession> {
    this.sessions.set(key, session);      // ① 先改内存
    try {
        await this.persist();             // ② 再落盘 —— 必须等写完才算成功
    } catch (error) {
        if (this.sessions.get(key) === session) this.sessions.delete(key);  // ③ 写失败？内存回滚
        throw error;
    }
    return { session, isNew: true };      // ④ 落盘成功，才对外说"会话建好了"
}
```

- await 保证顺序：①→②→④，不 await 的话 ④ 先跑，重启就丢会话
- 失败回滚：② 失败 → ③ 撤掉内存 → 整个 resolve 像没发生过

**心法：await 是"先做完 A 才能做 B"的强制排序器。**

### Level 3：看不见的 await —— Promise 链串行队列（`src/core/session-store.ts`）

```ts
save(sessions: Session[]): Promise<void> {
    const snapshot = JSON.stringify(sessions, null, 2);
    const write = async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(tempPath, `${snapshot}\n`, "utf8");
        await rename(tempPath, this.filePath);   // 原子替换
    };
    this.writeQueue = this.writeQueue.then(write, write);  // 串行化
    return this.writeQueue;
}
```

`Promise.then()` 和 await 是同一件事的两种写法：

```ts
const result = await somePromise;              // 写法 A：等这份外卖
somePromise.then((result) => { ... });         // 写法 B：给外卖到了安排"做什么"
```

`writeQueue = writeQueue.then(write, write)` 的效果：
- 第一次：`Promise.resolve()` 立刻执行第一次写入
- 第二次：等**上一次写完**才开始 → 所有写入串成一条链，永不并发
- 第二个参数也传 `write`：即使某次写失败，队列继续排下一次（容错队列，不卡死）

**心法：多个异步操作必须"排队挨个来"时，用 `.then` 串成链。**

### Level 4：手搓外卖 —— 双路竞争（`src/index.ts`）

```ts
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);

    return new Promise((resolve) => {                    // 亲手开一家外卖店
        const timer = setTimeout(() => {                 // 路 A：时间到
            signal.removeEventListener("abort", stopWaiting);
            resolve(true);
        }, ms);

        const stopWaiting = () => {                      // 路 B：被取消
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener("abort", stopWaiting, { once: true });
    });
}
```

- 两路外卖同时在路上：`setTimeout`（时间到）/ `abort` 事件（用户 /close）
- **谁先到谁 `resolve`**，等待结束；路 B 还要清掉路 A 的定时器，防止重复 resolve

**心法："等两件事，谁先到算谁"——用 `new Promise` 手动 resolve，两个回调都注册。**

### Level 5：三重调度之王 —— `ThrottledCardUpdater`（`src/im/card.ts`）

```ts
export class ThrottledCardUpdater {
    private pendingCard: CardJson | undefined;           // 暂存"最新一张卡片"
    private timer: ReturnType<typeof setTimeout> | undefined;  // 节流闹钟
    private updateChain: Promise<void> = Promise.resolve();    // 发送队列
    private closed = false;

    push(card: CardJson): void {                 // 高频调用，不等任何事
        if (this.closed) throw new Error("卡片更新器已经结束");
        this.pendingCard = card;
        this.schedule();
    }

    async finish(finalCard: CardJson): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.pendingCard = undefined;
        await this.updateChain;                     // ① 等队列排空
        await this.updateCard(finalCard);           // ② 再发终态
    }

    async cancel(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.pendingCard = undefined;
        await this.updateChain;                     // 等队列清空即可
    }

    private schedule(): void {
        if (this.timer) return;                     // 闹钟在走就不重设（节流核心）
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flushPending();
        }, this.intervalMs);
    }

    private flushPending(): void {
        const card = this.pendingCard;
        this.pendingCard = undefined;
        if (!card || this.closed) return;
        this.updateChain = this.updateChain        // 发到队列排队
            .then(() => this.updateCard(card))
            .finally(() => {
                if (this.pendingCard && !this.closed) this.schedule();  // 期间又有新卡片？继续节流
            });
    }
}
```

三重调度拆解：
- **调度一（节流闹钟）**：`schedule()` 里 `if (this.timer) return` —— 2 秒窗口内无论 push 多少次，只设一个闹钟，到点只发"最新那张"
- **调度二（发送队列）**：`updateChain` 用 Promise 链串行，后一次发送永远等前一次完成，不并发不乱序
- **调度三（等待排空）**：`finish()` 先 `await this.updateChain` 再发终态——否则终态可能插队到中途更新前面

### Level 6：在入口串起来 —— 什么时候该等，什么时候不该等（`src/index.ts`）

```ts
async function runCardDemo(bot, cardId, resolved, signal): Promise<void> {
    const updater = new ThrottledCardUpdater(async (card) => {
        await bot.updateCard(cardId, card);
    });

    for (const [index, step] of DEMO_STEPS.entries()) {
        if (!(await wait(700, signal))) {     // 等 700ms，可被 /close 取消
            await updater.cancel();
            return;
        }
        ...
        updater.push(buildTaskCard({ ... }));       // 不 await：放火就走
    }
    await updater.finish(buildTaskCard({ ... }));   // 要 await：终态必须确认发出
}
```

| 代码 | 为什么这样处理 |
|---|---|
| `await wait(700, signal)` | 这步的进度**必须依赖**等待结果 |
| `updater.push(...)` 不 await | push 只是"记状态+设闹钟"，不需要等 |
| `await updater.finish(...)` | 终态**必须确认发出**，任务才算完成 |
| `await updater.cancel()` | 取消也要等队列清空，避免半路请求在飞 |

入口处"后台点火"模式：

```ts
cardId = await bot.replyCard(...);   // 要等：后续更新需要这个 message_id
void runCardDemo(bot, cardId, resolved, run.signal)   // 不等：后台继续跑
    .catch((error) => { console.error(...); })
    .finally(async () => { ... markSessionIdle(...) });
```

`void` = 明确告诉读者"这个 Promise 我不等"。但不等不代表不管——`.catch` 兜后台错误，`.finally` 保证会话回 idle。**可以不等，但必须有收尾。**

### await 速查表

| 看到什么 | 心法 |
|---|---|
| `await xxx()` | 这步必须等 xxx 完成（要结果 / 保顺序） |
| `async function` | 内部有 await 的传染结果，可能返回失败的 Promise |
| `try { await } catch` | 外卖可能送不到，决定兜底还是上抛 |
| `.then(cb)` | 外卖到了之后做什么（await 的另一种写法） |
| `.then().finally()` | 无论如何都要收尾 |
| `new Promise((resolve) => ...)` | 手搓外卖店，自己决定什么时候"算完成" |
| `void somePromise.catch(...)` | 不等它，但后台失败要有兜底 |
| 调用方不 await 一个 async 函数 | 错误会变"未处理拒绝"，可能让进程崩 |

---

## 2. Promise 链与错误传播

### 2.1 先立模型：Promise 的三态

一份"外卖"（Promise）只有三种状态：

```
pending（已下单，在路上）
  ├──► fulfilled（送到了，有结果）  ← await 拿到值 / .then 收到值
  └──► rejected（送丢了/坏了）      ← await 抛出异常 / .catch 收到错误
```

两个关键等价关系（记住它们，全章就通了）：

```ts
// 在 async 函数里：
throw new Error("坏了");          // ≡  return Promise.reject(new Error("坏了"))
// 一个 rejected 的 Promise 被 await：
const x = await brokenPromise;    // ≡ 抛出异常，被最近的 try/catch 接住
```

**结论：错误在 async 世界里不是"返回值"，而是"抛出的异常"，靠 await 传输。**

### 2.2 错误像滚雪球：逐层上抛

看 `src/core/session-store.ts` 的完整链路——从最底层到最外层，错误怎么一层层传：

```
① writeFile/rename 失败（磁盘故障）
   └─► JsonSessionStore.save() 的 write() 抛错
        └─► writeQueue 变 rejected
             └─► SessionManager.persist() 里 await this.store?.save(...) 抛出
                  └─► resolve()/transition() 的 catch：
                       先回滚内存（delete / 还原旧值）
                       再 throw error ← 错误继续上抛，但局部状态已收拾干净
                            └─► index.ts 的 sessions.resolve(msg)（没有 try/catch）
                                 └─► startBot 的 onMessage 回调抛出
                                      └─► 飞书 SDK 的事件分发捕获，记录日志
```

**心法：每个环节只有两个选择——"接住它"（处理或兜底）或"继续抛"（throw，让上面一层决定）。** 你项目里每个 `throw error` 都是"我这里收拾干净了，但问题本身我没资格拍板，交上去"。

注意 `resolve()` 回滚的设计深意：**先改内存 → 落盘 → 失败则撤销内存**。因为内存是"事实"，磁盘是"备份"，以磁盘成功为准对外宣布成功——保证"说过的话必须真做到了"。

### 2.3 链上的错误会跳过成功回调

`ThrottledCardUpdater.flushPending()`（`src/im/card.ts`）：

```ts
this.updateChain = this.updateChain
    .then(() => this.updateCard(card))   // 成功才执行（发卡片）
    .finally(() => { ... });             // 无论成败都执行（安排下一次节流）
```

- `updateCard` 失败 → 跳过之后的成功回调（这里没有），直达最近的错误处理者
- `.finally()` **无论如何都执行** → 放清理/收尾逻辑（如继续节流安排）
- 错误没有被 `.catch` 接住的话，会沿着链继续往下传，直到整个 Promise 被接住

**心法：`.then(成功回调)` / `.catch(错误回调)` / `.finally(收尾)` 三段式，是 Promise 世界的标准结构。看到一条链，从左往右读：成功做什么 → 失败做什么 → 最后不管怎样做什么。**

### 2.4 完整链路实例一：卡片更新的错误路径（`src/index.ts`）

```
bot.updateCard() 网络失败
→ ThrottledCardUpdater.updateChain rejected
→ runCardDemo 里 await updater.finish(...) 抛出
→ runCardDemo 的 Promise rejected
→ index.ts 的 .catch 接住，打日志（console.error("[卡片] 演示失败")）
→ .finally 接住善后：activeRuns 删除 + markSessionIdle
```

```ts
void runCardDemo(bot, cardId, resolved, run.signal)
    .catch((error) => {
        console.error("[卡片] 演示失败:", (error as Error).message);
    })
    .finally(async () => {
        if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
        try {
            await markSessionIdle(session.id);   // finally 里的 await 也可能失败，也要 try/catch
        } catch (error) {
            console.error('[会话] 保存空闲状态失败:', (error as Error).message);
        }
    });
```

两个细节：
1. **finally 里用 async 函数 + 内层 try/catch**——`finally` 本身不管 Promise 成败，但里面如果又有 await，它自己也可能失败，要再兜一层
2. **错误在这里被"消化"了**（只打日志）——因为后台演示任务失败不影响系统主流程，不需要上抛

### 2.5 完整链路实例二：replyCard 失败的双重处理（`src/index.ts`）

```ts
try {
    cardId = await bot.replyCard(...);
} catch (error) {
    if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);  // 局部清理①：撤掉运行标记
    markSessionIdle(session.id);                                            // 局部清理②：会话回 idle
    throw error;                                                            // 然后继续上抛！
}
```

这是"**处理但不吞掉**"的典型：本层该做的清理（撤运行标记、回 idle）做掉，但错误本身**不属于本层**（是飞书网络问题，SDK 层需要知道），所以 `throw error`。

对比 2.4 的"消化"：那里的错误属于后台任务，消化即可；这里的错误会影响"会话状态对不对"，所以要清理后上抛。**区分标准：这个错误影响谁？影响局部就局部消化；影响上层状态就清理后上抛。**

### 2.6 未接住的错误 = unhandled rejection（杀手）

```ts
someAsyncFunction();   // 没有 await、没有 .catch —— 灾难
```

- async 函数永远返回 Promise，**不接住它的 rejected = unhandled rejection**
- Node 默认行为：**直接让进程退出**（或至少打印红色大警告）
- 你项目里"莫名其妙的进程退出"，十有八九是这个

正确姿势（你代码里的标准示范）：

```ts
void runCardDemo(...)          // 明确"我不等"
    .catch(...)                // 但错误必须有人接
    .finally(...);             // 收尾必须有人做
```

**心法：async 函数的错误不会自己消失。要么 await（try/catch 接），要么 .catch 接，没有第三条路。**

### 2.7 Promise 链速查表

| 概念 | 一句话 |
|---|---|
| Promise 三态 | pending / fulfilled（await 拿值）/ rejected（await 抛错） |
| `throw` 与 reject | async 里 `throw` ≡ `Promise.reject` |
| await 与错误 | await 一个 rejected 的 Promise = 抛出异常 |
| 错误传播 | 每个环节只能"接住"或"throw 继续抛" |
| `.then(onOk, onErr)` | 成功做什么 / 失败做什么 |
| `.catch(cb)` | 接住链上第一个错误（等价 .then 第二参数） |
| `.finally(cb)` | 无论成败都执行的收尾 |
| 消化 vs 上抛 | 影响局部→消化（打日志）；影响上层状态→清理后 throw |
| unhandled rejection | async 函数错误没人接 → 进程可能退出 |
| finally 里又 await | 也要 try/catch，因为收尾动作也可能失败 |

---

## 3. AbortController 取消机制：`/close` 的完整链路

### 3.1 模型：取消是广播，不是命令

```ts
const run = new AbortController();   // 喇叭
run.signal                           // 收听器（AbortSignal）
run.abort()                          // 喊一嗓子 → 所有拿着 signal 的人同时听到
```

- **controller**（发出者）：只有一处，`index.ts` 里创建，`/close` 时喊话
- **signal**（收听者）：传进 `runCardDemo` → `wait`，谁持有谁感知取消
- 设计本质：**取消权在调度层，取消感知在执行层**——任务本身没有"决定被取消"的权力，它只是听话

### 3.2 完整链路

正常任务流：

```
消息进来 → 状态守卫 → transition(id, "active")      ① 状态上锁
        → new AbortController()                    ② 造喇叭
        → activeRuns.set(id, run)                  ③ 登记在案
        → 下载资源（失败仅打日志）
        → await bot.replyCard(...) 拿到 cardId     ④ 发 running 卡片
        → void runCardDemo(..., run.signal)        ⑤ 后台点火，不 await
```

`/close` 流（后台同时发生）：

```
用户发 /close
→ activeRuns.get(session.id)?.abort()      ← 喊一嗓子！
→ sessions.transition(id, "closed")         ← 会话上"死锁"
→ await bot.reply("当前会话已关闭...")
        │
        ▼ （后台）
→ wait() 的 abort 监听器触发（路B）
→ stopWaiting(): clearTimeout(timer)        ← 掐掉路A定时器
→ resolve(false)                            ← 等待以"被取消"结束
→ runCardDemo: if (!(await wait(700, signal))) 拿到 false
→ await updater.cancel()                    ← 卡片队列排空（不发终态）
→ return
→ .finally: activeRuns.delete(id) + markSessionIdle(id)
```

关键：**`/close` 不等任务真正停**——它广播 + 上锁 + 回话，任务在后台自己收尾。

### 3.3 三个防护细节（都是防"谁先谁后的竞态"）

**① `activeRuns.get(id) === run` 防误删他人**

```ts
if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
```

时序：任务 A 收尾中 → 新任务 B 登记（`activeRuns.set(id, runB)`）→ A 的 finally 直接 delete 会误删 B 的 run。`=== run` 保证：**map 里还是我这个 run 才删，换了人就别动**。

**② `markSessionIdle` 的 status 检查 —— 防把"死人"救活**

```ts
function markSessionIdle(sessionId: string): void {
    if (sessions.get(sessionId)?.status !== "active") return;  // 只对 active 生效
    sessions.transition(sessionId, "idle");
}
```

任务收尾 vs `/close` 的 `transition(closed)` 谁先执行都可能。无脑 `transition(idle)` 会把 closed 顶回 idle。这个检查让结果与顺序无关：**无论先后，最终状态都是 closed 优先**。

**③ wait() 的监听器卫生 —— 防泄漏 + 防重复**

```ts
const timer = setTimeout(() => {
    signal.removeEventListener("abort", stopWaiting);  // 用完就拆
    resolve(true);
}, ms);
signal.addEventListener("abort", stopWaiting, { once: true });  // 双保险
```

任务跑 N 步 = N 次 wait = N 个监听器。`resolve(true)` 前必须 `removeEventListener`；`{ once: true }` 保证即使忘了拆也只触发一次；`if (signal.aborted)` 提前短路已取消的信号。

### 3.4 取消的两种响应方式

| 方式 | 代码 | 语义 |
|---|---|---|
| 值驱动 | `wait` 返回 `false`，`runCardDemo` 判断 | 取消是软的：业务代码决定怎么走 |
| 队列排空 | `await updater.cancel()` | 取消是硬的：必须等队列清空，不留半路请求 |

### 3.5 真实瑕疵：`transition` 没 await（`src/index.ts` /close 分支）

> ✅ 已于本次修订修复：改为 `await sessions.transition(...)`，并加注释说明原因。

```ts
// 修复前
if (session.status !== "closed") sessions.transition(session.id, "closed");  // 没 await！
// 修复后
if (session.status !== "closed") await sessions.transition(session.id, "closed");
```

为什么必须 await：
- `transition` 是 async（内部 `await persist()`），不 await 落盘失败 → unhandled rejection，进程可能退出
- `/close` 不等落盘完成就回"已关闭"：磁盘可能仍是 active，重启后 `recoverInterruptedSession` 会把它复活成 idle
- 教学价值：这是第 2 章 2.6 的坑在真实代码里的实例——读代码能力的价值就在定位这种瑕疵

### 3.6 小结

| 概念 | 一句话 |
|---|---|
| AbortController | 取消是广播：controller 喊话，signal 收听 |
| 链路 | /close → abort() → wait 监听器 → resolve(false) → cancel() → 收尾 |
| `=== run` 保护 | 只删自己的登记，不误删新任务 |
| markSessionIdle 检查 | 只把 active 拉回 idle，不覆盖 closed |
| 监听器卫生 | removeEventListener + once + 提前检查 aborted |
| 软取消 vs 硬取消 | 返回值驱动 vs 队列排空 |

---

## 4. 事件循环直觉：为什么 onMessage 必须快、await 为什么能放手

### 4.1 核心问题：为什么不用 await runCardDemo（`src/index.ts`）

```ts
// 让事件回调尽快返回，后续模拟更新在后台继续。
void runCardDemo(bot, cardId, resolved, run.signal)   // 不是 await！
    .catch(...)
    .finally(...);
```

**先澄清：`void` 和 `await` 的"点火"一模一样**——async 函数从调用那一刻就同步执行，直到撞上第一个 `await` 才挂起。区别不在任务启动，而在：**onMessage 要不要站在原地等任务完成？**

**证据：飞书 SDK 按 chatId 串行分发消息**（`node-sdk/lib/index.js` 的 `ChatPipeline`）：

```js
// SDK 内部：每个 chat 一条 pipeline，tail 是 Promise 链
class ChatPipeline {
    this.tail = Promise.resolve();
    enqueueFlush() {
        const next = this.tail.then(task, task);   // 后一条永远等前一条
        this.tail = next.then(() => undefined, () => undefined);
    }
}
// 消息处理：SDK 在 await 用户回调
const dispatchHandler = (batch) => __awaiter(this, void 0, void 0, function* () {
    try { yield this.onMessage(batch.message); } catch (e) { ... }  // ← await 用户回调
    finally { ... 释放锁 ... }
});
if (this.queueEnabled) this.manager.push(msg.chatId, msg, dispatchHandler);  // 入队串行
```

翻译：**SDK 会等你的 `onMessage` 完全返回，才处理这个 chat 的下一条消息**。onMessage 挂多久，这个群的后续消息就排队等多久。

**时间线对比**（8 步 × 700ms ≈ 5.6 秒的任务）：

```；
❌ await 版：
 t=0     用户发任务 → onMessage 开始
 t=5.6   step8 完成 → onMessage 才返回
         │  期间 t=1.0 用户发 /close → 进队列排队等 5.6 秒
 t=5.7   /close 才被处理 → abort() → 任务已经跑完了

✅ void 版：
 t=0     用户发任务 → onMessage：登记/发卡片/点火 → 约 1 秒返回
 t=0.2   用户发 /close → 立即处理 → abort() → 广播取消
 t=0.9   后台任务感知取消 → 收尾 → 会话 closed
```

**心法：onMessage 是你的"前台柜台"——柜台响应越快，用户插话越灵。长任务一律 `void` 点火后台跑（+ catch + finally），柜台只做登记。** 第三讲 `/close` 链路能成立的前提就是柜台不卡：如果 onMessage 卡住，abort 根本触发不了。

补充：`await replyCard` 是必须等的边界——它需要 cardId 作为后续更新锚点，且很快（一个网络往返），"该等的等，不该等的不等"。

### 4.2 等待者 vs 被等待者（容易搞反的概念）

```
await runCardDemo(...) 这一行发生时：

    onMessage（柜台）                         runCardDemo（后厨）
         │                                        │
         ▼                                        ▼
  站桩在 await 这行 ←── 等 ─────────────────────►  在后台正常跑
  （挂起，不返回）             5.6 秒              每 700ms 被唤醒一步
         ▲                                        │
         └──────── 完成后唤醒 onMessage ───────────┘
                   继续执行 await 后面的代码 → 返回

   事件循环里其他的事（别的 chat 消息/定时器/网络）：一切照常
```

**`await` 挂起的是"当前正在执行的函数"（onMessage），不是被等的那个（runCardDemo）。** 像叫外卖：你（onMessage）站在门口等，骑手（runCardDemo）正常骑车来，邻居（事件循环）该干嘛干嘛——被等住的是你，不是骑手。

### 4.3 事件循环全景：单线程怎么同时干多件事

```
                 ┌──────────────────────────────────────────────┐
                 │              事件循环（总调度）                 │
                 │                                              │
                 │    ┌───────────────┐                        │
                 │    │    调用栈       │   ← 当前正在执行的代码   │
                 │    │ （一次只跑一段） │                        │
                 │    └───────┬───────┘                        │
                 │            │ 栈空了                          │
                 │            ▼                                │
                 │    ┌────────────────┐                       │
                 │    │   微任务队列     │  ← Promise 的 .then / │
                 │    │ （来一个清一个） │    await 的后半段       │
                 │    └───────┬────────┘                       │
                 │            │ 清空了                          │
                 │            ▼                                │
                 │    ┌────────────────┐                       │
                 │    │   宏任务队列     │  ← setTimeout / 网络   │
                 │    │ （每次只取一个） │   回调 / 消息处理       │
                 │    └────────────────┘                       │
                 │                                              │
                 │   循环规则：栈空 → 清空微任务 → 取一个宏任务     │
                 │            → 回到栈空 → 清空微任务 → ……        │
                 └──────────────────────────────────────────────┘
```

**单线程 = 同一时刻只跑一段代码（调用栈只有一条），但"排队 + 让出"让所有事都有机会被轮到。分时，不是并行。**

### 4.4 setTimeout 是"预约"，不是"定时执行"

```
setTimeout(cb, 700) 执行那一刻：

    调用栈：执行 setTimeout(cb, 700)
        │
        ▼
    计时器登记表：{ 700ms 后把 cb 扔进宏任务队列 }   ← 登记完【立即返回】
        │
        ▼
    调用栈继续跑后面的代码（不阻塞！）
        │
        │        （700ms 期间，事件循环该干嘛干嘛）
        ▼        700ms 到了
    计时器到点：把 cb 扔进宏任务队列末尾【排队】
        │
        ▼
    事件循环：等调用栈空了，才轮到 cb 真正执行
```

两个时间点是分开的：**700ms = 入队时间**（到点入队）；**真正执行时间 = 队列轮到它 + 调用栈空**（可能早可能晚）。所以 `wait(700)` 的"等 700ms"其实等的是"入队 + 轮到"。

### 4.5 await 是"让出 + 后半段排队"

```
await wait(700, signal) 执行那一刻：

    调用栈：执行 wait(...)
        │  wait() 注册 setTimeout + abort 监听 → 立刻返回 pending Promise
        ▼
    await 看到 pending → 把当前函数【挂起】
        │  挂起点之后的所有代码，打包成一个"微任务"
        ▼
    调用栈空了 → 事件循环去做别的事（消息/定时器/网络）
        │
        │  （700ms 后 setTimeout 到点 → wait 内部 resolve 执行）
        ▼
    Promise fulfilled → 打包好的"后半段"被扔进【微任务队列】
        │
        ▼
    事件循环回到栈空 → 先清空微任务 → runCardDemo 从 await 那行继续
```

**await 不阻塞的本质：它只是"把自己后半段寄存到队列里，然后放手"。放手 = 控制权还给事件循环。**

### 4.6 完整一帧：把前几讲串起来（`src/index.ts` runCardDemo）

```
帧开始：runCardDemo 执行到 await wait(700, signal)

    ┌─ 调用栈：runCardDemo ─────────────────────────┐
    │  wait() 注册：{ setTimeout 700ms, abort 监听 } │
    │  挂起 runCardDemo，后半段打包进微任务           │
    │  调用栈空                                      │
    └───────────────────────────────────────────────┘
                │
                ▼  接下来 700ms 里，事件循环循环往复：
    ┌──────────────────────────────────────────────┐
    │  宏任务：飞书 WS 心跳回包                       │
    │  宏任务：用户发 /close → onMessage → abort()   │ ← 取消广播！
    │         （柜台是空的，所以立刻被接待）          │
    │  微任务：各 Promise 的 .then 收尾               │
    └───────────────────────────────────────────────┘
                │
                ▼  700ms 到点（或 abort 触发）
    ┌──────────────────────────────────────────────┐
    │  宏任务：setTimeout 到点 → wait 的 resolve 执行  │
    │  微任务：runCardDemo 被唤醒，从 await 行继续     │
    │         拿到 true → 下一步；false → 取消收尾     │
    └───────────────────────────────────────────────┘
```

这一帧把全章串起来：**setTimeout 预约 → await 让出 → 事件循环处理别的事（包括 /close）→ 到点唤醒 → 继续**。这就是"为什么事件循环里其它事情能正常运行"的完整答案。

### 4.7 小结

| 现象 | 底层真相 |
|---|---|
| setTimeout 不阻塞 | 只是登记一个"预约"，登记完立即返回 |
| await 不阻塞 | 只是把后半段寄存在微任务队列，然后放手 |
| 其它事情正常运行 | 放手期间，事件循环在栈空时反复处理两个队列里的其他任务 |
| onMessage 必须快 | SDK 按 chatId 串行分发，onMessage 不返回则本 chat 下一条消息排队 |
| void vs await | 点火相同；void 不站桩立即返回，await 站桩等 Promise 完成 |

---

## 5. 并发控制模式：你项目里的六种武器

### 5.0 总览：并发问题的本质

并发问题 = **多个异步操作同时发生，顺序乱了**。六种武器：

```
            ┌─────────────────────────────────────────────────┐
            │       并发控制的六种武器（你的项目全部在用）         │
            ├──────────────┬──────────────────────────────────┤
            │ 问题          │ 武器 → 源码位置                    │
            ├──────────────┼──────────────────────────────────┤
            │ 写文件会打架   │ 串行队列 → session-store writeQueue │
            │ 卡片更新太频繁 │ 节流合并 → card.ts schedule         │
            │ 超时和取消竞争 │ 竞速     → index.ts wait()          │
            │ 同一会话重复跑 │ 互斥锁   → 状态机 + activeRuns      │
            │ 收尾被重复调   │ 幂等     → markSessionIdle          │
            │ 磁盘写一半     │ 原子写   → tmp + rename            │
            └──────────────┴──────────────────────────────────┘
```

### 5.1 武器 1：串行队列 —— "挨个来，不许插队"（`src/core/session-store.ts`）

```ts
this.writeQueue = this.writeQueue.then(write, write);  // 后一次等前一次
return this.writeQueue;
```

```
        并发到达的 4 次写请求
             │  │  │  │
             ▼  ▼  ▼  ▼
        ┌──────────────────────┐
        │   串行队列（Promise链） │
        │  写1 ─► 写2 ─► 写3 ─► 写4 │   ← 每个必须等前一个完成
        └──────────────────────┘
            磁盘上永远不会有两个写同时进行
```

**"必须挨个来"的操作，用 `.then` 串成链。**

### 5.2 武器 2：节流 + 合并最新 —— "攒着，定期只发最新的"（`src/im/card.ts`）

```ts
push(card) {
    this.pendingCard = card;   // 只保留"最新一张"
    this.schedule();
}
schedule() {
    if (this.timer) return;    // 已有闹钟就不重设 ← 节流核心
    this.timer = setTimeout(() => { this.flushPending(); }, 2000);
}
flushPending() {
    const card = this.pendingCard;  // 到点只发"最新那张"
    ...
}
```

```
push 到达： |● ● ● ●|  |● ● ●|  |● ● ● ● ●|
            └─2s窗口─┘  └2s窗口┘  └──2s窗口──┘
实际发送：      1 次       1 次         1 次
              （每次都只发窗口内最新的一张）
```

**高频状态更新 → 定期合并成低频网络交互**（卡片仪表盘全靠它）。

### 5.3 武器 3：竞速 —— "谁先到算谁"（`src/index.ts` wait）

```ts
const timer = setTimeout(() => { resolve(true); }, ms);            // 路A：时间到
const stopWaiting = () => { clearTimeout(timer); resolve(false); };// 路B：被取消
signal.addEventListener("abort", stopWaiting, { once: true });
```

```
              ┌─ 路A：setTimeout(700ms) ──────────┐
              │                                   │
   启动 ──────┤      谁先到，谁 resolve             ├──► 等待结束
              │      （另一个被忽略/清理）           │
              └─ 路B：abort 事件（用户 /close）────┘
```

**"两个结局竞争"用 `new Promise` 手动 resolve，先到先得。**

### 5.4 武器 4：互斥锁 —— "同一时间只让一个人干活"（`src/index.ts` + 状态机）

```ts
if (session.status === "active") {   // 锁已占用？
    await bot.reply("当前会话还在执行，请等任务结束后再追问。");
    return;                          // 拒绝
}
sessions.transition(session.id, "active");   // 拿锁
```

```
同一话题来了两条消息：
 消息A ─► 检查状态：idle → 拿锁（转 active）── 执行中 ──► 释放锁（转 idle）
 消息B ─► 检查状态：active！→ 拒绝："还在执行"
```

**用状态机当锁：`active` = 锁已占用，转移表 = 谁能拿锁。**

### 5.5 武器 5：幂等 —— "重复做无害"（`src/index.ts` markSessionIdle）

```ts
function markSessionIdle(sessionId: string): void {
    if (sessions.get(sessionId)?.status !== "active") return;  // 不是 active 就不动
    sessions.transition(sessionId, "idle");
}
```

```
连续调用 markSessionIdle 三次：
 第1次：status=active ─► 转 idle ✅
 第2次：status=idle   ─► 直接 return（无事发生）
 第3次：status=idle   ─► 直接 return（无事发生）
 → 重复调用无害 = 幂等
```

**"只对特定状态生效"的操作天然幂等。**

### 5.6 武器 6：原子写 —— "要么全有，要么全无"（`src/core/session-store.ts`）

```ts
const tempPath = `${this.filePath}.tmp`;
await writeFile(tempPath, `${snapshot}\n`, "utf8");   // 先写临时文件
await rename(tempPath, this.filePath);                // 再原子替换
```

```
      写文件的过程：
      写 tmp ──────────────► rename 替换原文件
         │                      │
         └── 崩溃点在这 ──┘
             tmp 残留（垃圾），
             原文件完好（还是旧数据）→ 下次启动用旧的，不损坏
```

**先写临时文件再原子改名，磁盘上任何时刻只有完整的新文件或完整的旧文件。**

### 5.7 怎么选武器

```
遇到并发问题，先问四个问题：
 ① 必须挨个来？          → 串行队列（writeQueue）
 ② 更新太频繁？          → 节流+合并（ThrottledCardUpdater）
 ③ 两个结局在竞争？      → 竞速（wait）
 ④ 会重复触发/重复调用？ → 互斥锁 + 幂等（状态机 + status 检查）
 ⑤ 要写磁盘？           → 原子写（tmp+rename）
```

---

## 6. 读复杂函数的五步法

### 6.1 五步法地图

```
① 看签名   ──► 它是什么？要什么？给什么？
② 画状态   ──► 有哪些会变的变量？（这就是"它的记忆"）
③ 找入口   ──► 谁调用它？高频还是低频？
④ 追异步   ──► 哪些 await/.then/setTimeout？顺序约束是什么？
⑤ 想竞态   ──► 两个调用交错时，谁保护了谁？
```

### 6.2 实战：套在 `ThrottledCardUpdater`（`src/im/card.ts`）上

**① 看签名**

```ts
new ThrottledCardUpdater(updateCard, intervalMs = 2_000)
//         │                │            │
//         │                │            └─ 节流窗口：2 秒
//         │                └─ 真正的网络请求（发给飞书）
//         └─ 一个"包装发送"的工具：push 收卡，定期发最新
```

结论：**一个节流发送器**——不管卡片内容，只负责"什么时候发、发哪张"。

**② 画状态**（找 `private` 字段——对象就是靠它们"记住"事情的）

```ts
private pendingCard   // 待发的最新卡片（会被覆盖）
private timer         // 闹钟（有就是"在等 2 秒"）
private updateChain   // 发送队列（Promise 链）
private closed        // 开关（true = 已经结束）
```

结论：**四样记忆：待发的卡、闹钟、队列、开关**。一个对象的行为 = 这些状态在不同调用下的组合。

**③ 找入口**

```
push(...)    高频（任务每 700ms 推一次新进度）
finish(...)  低频一次（任务正常结束）
cancel(...)  低频一次（任务被取消）
```

结论：**一个高频入口 + 两个低频入口**——形状即设计：push 必须快、收尾必须稳。

**④ 追异步**（找 `setTimeout` / `.then` / `await`）

```
push → schedule()：设 2s 闹钟（已有闹钟就不重设）
2s 到点 → flushPending()：把最新卡入队
       → updateChain.then(updateCard)：真正发网络请求（排队串行）
finish → await updateChain（等队列排空）→ await updateCard(finalCard)
```

结论：**三段时间约束：2s 节流窗口 → 队列串行 → 收尾等排空**。

**⑤ 想竞态**（问：两个调用交错会怎样？）

```
push 和 finish 几乎同时：
  push 之后又 push：pendingCard 被覆盖，只发最新 → 无害（节流本意）
  finish 后还有人 push：closed=true，push 直接抛错 → 防"死后的任务还发卡"
  cancel 和 finish 同时：都检查 closed，第一个执行，第二个直接 return
```

结论：**`closed` 开关是总闸，防的是"结束之后还在动"**。

### 6.3 总结

```
┌─────────────────────────────────────────────────┐
│  ① 签名：函数名就是注释，参数就是输入，返回就是输出   │
│  ② 状态：private 字段 = 对象的记忆，先数清楚有几样    │
│  ③ 入口：谁调用它？高频/低频？形状即设计             │
│  ④ 异步：setTimeout/.then/await 就是"时间约束"      │
│  ⑤ 竞态：两个调用交错，谁保护了谁？找 if/开关/锁     │
└─────────────────────────────────────────────────┘
```

复杂函数无非是"状态多 + 入口多 + 异步多 + 竞态多"，五步法正好把它们拆开。

---

## 7. 完。回头看这六讲

```
1. await        —— 等外卖；要外部就要等；await 传染
2. Promise 链    —— 错误像滚雪球；每个 async 都要有人接
3. AbortController —— 取消是广播；/close 全链路
4. 事件循环      —— 单线程分时；onMessage 必须快
5. 并发控制      —— 六种武器：队列/节流/竞速/锁/幂等/原子写
6. 读函数五步法  —— 签名/状态/入口/异步/竞态
```
