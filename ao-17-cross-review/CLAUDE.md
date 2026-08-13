# agent-os

以飞书话题群为操作界面、Claude Code 与 Codex 为执行引擎的个人生产系统。一个进程可以运行多个 bot，每个 bot 只处理明确发给自己的消息，并拥有独立的角色、默认引擎与话题会话。

## 运行

```bash
pnpm start       # watch 模式启动，源码或 bot 配置变化后自动重启
pnpm dev         # pnpm start 的别名
pnpm start:once  # 单次启动
```

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 `.env`（已 gitignore），绝不硬编码、绝不提交
- bot 清单写在 `config/bots.json`，真实文件已 gitignore
- `appIdEnv` 与 `appSecretEnv` 只保存环境变量名，不保存真实凭证
- 每个 bot 的 `defaultCli` 可设为 `claude` 或 `codex`
- 每个 bot 用 `workspace` 指定默认项目目录；话题里的 `/cd` 只覆盖当前会话
- 工作目录变化后必须清除旧 CLI 会话 ID，避免把旧项目上下文带进新目录
- Claude Code 与 Codex 的模型服务使用各自的用户级配置，不把模型密钥写进项目 `.env`

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- pnpm v11 默认拒绝依赖的构建脚本（esbuild 装完不可用）→ 在 `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }` 放行
