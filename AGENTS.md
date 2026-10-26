# AGENTS.md

## Environment

- **Runtime**: Bun (`packageManager: bun`). Always use `bun install`, `bun run <script>`.
- **Nix-first**: If the host lacks `bun`, `node`, etc., create or update `flake.nix` (`nix develop` / `nix shell`) instead of assuming global installs.
- **No npm/pnpm/yarn**.

## Commands

```bash
bun install          # install deps (applies patches/ via patchedDependencies)
bun run dev          # bun run --watch src/index.ts
bun run build        # tsc && tsc-alias && cp src/web/ui.html dist/web/ui.html
bun run start        # bun run dist/index.js  (needs Bun: the code uses bun:sqlite)
bun run build:binary # bun build --compile → dist/shit-bot (single-file binary)
bun run test         # bun test src — unit/integration tests (*.test.ts next to the code)
bun run typecheck    # tsc --noEmit -p tsconfig.test.json — type-checks src including tests
bun run docs:dev     # vitepress dev docs
```

Tests live next to the code as `src/**/*.test.ts`; `tsconfig.json` excludes them (and `src/testing/`) so they never land in `dist/`. Tests use `setupAiTest()` from `src/testing/fixtures.ts`: `setConfigForTesting(raw)` with the AI options under `plugins[ai-chat]`, `initDatabase(':memory:')` and the AI migrations. LLM calls are stubbed by replacing `globalThis.fetch`.

Build copies `src/web/ui.html` into `dist/web/` because tsc does not copy non-`.ts` assets. Any other non-`.ts` asset the runtime needs must either be copied the same way or embedded as a TS string constant (the default persona card is `src/plugins/ai-chat/persona/default-memecat.ts`).

## Architecture

- Single Bun process, not serverless/Workers. (`wrangler.jsonc` and the `deploy`/`preview` scripts are unrelated to the bot runtime.)
- `src/index.ts` — entrypoint: loads config → loads plugins (`init`) → `onConfigLoaded` → SQLite → renderer → Twitter client (optional) → Discord / Telegram / OneBot → slash commands (core + `onDiscordCommands`) → `onAfterInit` → web server → polling + plugin cron jobs.
- `src/config.ts` — config loader: first match of `data/config.{yaml,yml,toml,json}`, then `config.{yaml,yml,toml,json}` in the project root; merges env vars; validates. `getConfig()` loads the real config file lazily when nothing is loaded yet — tests and scripts must call `setConfigForTesting()` first, or run from an isolated directory.
- `src/storage.ts` — `bun:sqlite` (built into Bun, no native addon). DB at `<cwd>/data/bot.db`, WAL mode. Core tables only (`sent_tweets`, `image_cache`, `sent_messages`, `sent_tg_messages`, `sent_onebot_messages`, `pending_approvals`, `dead_letters`); plugins create their own.
- `src/bots/` — Discord (`discord.js`), Telegram (`telegraf`) and OneBot11 (QQ) clients. `discord.ts` creates the client; `discord-intents.ts` decides the privileged intents (members / presences) from the application flags before login (`discord.privilegedIntents: auto|on|off`) and the client retries without them if Discord rejects the login.
- `src/plugins/` — plugin system: `manager.ts` discovers built-in plugins (each sub-directory with an `index.ts`), GitHub plugins and `pluginsDir`, runs `init` and the hooks in `types.ts`.
- `src/plugins/ai-chat/` — the AI persona (memecat) over an OpenAI-compatible `/chat/completions` API, **Discord only**. Options live in `plugins[ai-chat].options` (a legacy top-level `ai:` is still read) and are normalized by `config.ts` (`getAiConfig()`).
  - Entry & Discord: `index.ts` (hooks: `onAfterInit` runs the AI migrations, loads personas / lore, registers pipelines, starts the worker and attaches handlers; `onDiscordCommands`; `onBeforeShutdown`), `discord-chat.ts` (message handler and direct replies; offers each message to other plugins via `onDiscordMessage` first), `discord-adapter.ts` / `discord-runtime.ts` (discord.js → ingest types, gateway events, member sync, history backfill, `channelQuoteGuard`), `discord-proactive.ts`, `discord-send.ts`.
  - Chat: `chat.ts` (tool loop, image inlining, reply JSON + reactions), `context.ts` (persona prompt + core memory blocks), `tools.ts` (tool schemas + dispatch), `llm-client.ts` (shared HTTP client: retries/timeouts, per-purpose token accounting in `llm_usage`, `jsonCompletion` with `response_format` fallback), `websearch.ts`, `time.ts` (UTC+8).
  - Data in: `ingest.ts` (every message → `messages`, keyed by user ID), `identity.ts` (users / members / name history), `mentions.ts` (`<@id>` → people), `history-sync.ts` (backfill / gap fill), `presence.ts`.
  - Memory: `memory/` (store, retrieval, extraction windows, profiles, stats, slash commands), `vector/` (embedder + adaptive sqlite-vec / JS backend), `persona/` + `lore.ts` (hand-written layer).
  - Relationship & behaviour: `affinity.ts`, `mood.ts`, `appraise.ts` (post-reply appraisal job), `proactive.ts` (interjection gate / score / judge / feedback).
  - Jobs & lifecycle: `worker.ts` (persistent `jobs` queue + schedulers; job types are only claimed while their feature is enabled in the *runtime* config), `retention.ts`, `forget.ts` (`/forget-me`), `forget-guard.ts` (salted-hash tombstones that stop re-import of deleted messages + a "forget epoch" that async jobs check before writing), `untrusted.ts` (structural isolation of untrusted text in prompts), `command-registry.ts` + `*-commands.ts` (slash commands, imported via `commands.ts`).
  - `db/` — versioned schema migrations for the AI tables (`schema.ts` holds the list, `migrate.ts` the runner, `meta.ts` a small `kv_meta` store). A failed migration only disables the AI memory features (`isAiSchemaReady()`), never the tweet pipeline. Append new migrations; never edit a released one.
- User-facing AI docs live in `docs/plugins/ai-chat/` (vitepress). README only keeps a summary that links there — keep numbers and rules there consistent with the code when you change behaviour.
- `src/twitter/` — X/Twitter API via `twitter-openapi-typescript`; supports cookie auth or username/password login with TOTP.
- `src/approval.ts` — multi-admin approval flow (Telegram inline keyboard + Discord buttons + OneBot11 text commands).
- `src/web/server.ts` — HTTP server on configurable port (default 3000). Serves `ui.html` + REST API for config CRUD.
- Config secrets are **never committed** — `config.yaml/json/toml` are in `.gitignore`.

## OneBot11 (QQ) 集成

通过 [OneBot11 协议](https://onebot.dev/) 支持 QQ 消息收发。

### 配置

```yaml
onebot:
  enabled: true
  url: "ws://127.0.0.1:8080"  # OneBot11 WebSocket 地址
  token: ""                    # 可选：访问令牌
  secret: ""                   # 可选：签名密钥
  reconnectInterval: 5000      # 重连间隔（毫秒）
```

或通过环境变量：
```bash
ONEBOT_ENABLED=true
ONEBOT_URL=ws://127.0.0.1:8080
ONEBOT_TOKEN=your_token
ONEBOT_SECRET=your_secret
```

### 群组配置

```yaml
groups:
  - name: my-group
    onebot:
      groupId: 123456789       # QQ 群号
      r14GroupId: 987654321    # R14 内容群号（可选）
    approval:
      onebotAdminGroupIds:     # 审批通知群号
        - 111222333
```

### 审批流程

OneBot11 使用文本命令进行审批：
- `/approve <审批ID>` — 批准推文
- `/reject <审批ID>` — 拒绝推文

审批消息会发送到配置的管理员群，包含推文内容和审批 ID。

### 文件结构

- `src/bots/onebot.ts` — OneBot11 WebSocket 客户端和消息发送
- `src/types.ts` — `OneBotConfig`, `GroupOneBotConfig` 类型定义
- `src/storage.ts` — `sent_onebot_messages` 表存储已发送消息

## Key gotchas

- Use the `bun:sqlite` API (`db.run`, `db.query(...).get/all`, `db.prepare`, `db.transaction`) — not `better-sqlite3`.
- `bun:sqlite`'s `.changes` includes rows changed by triggers. `messages` and `memories` have FTS sync triggers, so count rows with `SELECT COUNT(*)` before deleting instead of trusting `.changes` (it is fine as a `> 0` check).
- `bun test` runs all files in one process: module-level state (registered job handlers, schedulers, caches) leaks between test files. Reset what you depend on in `beforeEach`, and don't assume a handler is unregistered.
- Never run scripts that import `src/` or `dist/` from the project root against a real setup: an unset config makes `getConfig()` load the real `config.yaml`, and the DB is `<cwd>/data/bot.db`. Use `setConfigForTesting()` or an isolated working directory with its own config and `data/`.
- Background jobs that call an LLM must re-check that their subject still exists (message not deleted, user not `/forget-me`'d or opted out) after the call returns and before writing.
- Config file format is auto-detected by extension. Saving via the API writes back in the same format for YAML/JSON; a TOML config can be loaded but **not** saved (save throws). On `EROFS` (read-only mount in Docker) the save falls back to `data/`.
- When editing config via API, masked secrets (`••••••••`) are treated as "no change" — the existing value is preserved. Core secrets are masked by hand in `sanitizeConfigForAPI`; inside plugin `options`, any key ending in `apiKey` / `token` / `secret` / `password` is masked and restored automatically.
- New AI settings belong in `normalizeAiConfig()` (`src/plugins/ai-chat/config.ts`: defaults, clamps, env overrides) and in all three `config.example.*` files; a test checks that the examples match the defaults.
- `fetchAllTweets` exists in both `src/twitter/client.ts` and `src/rss/fetcher.ts`; `index.ts` imports the `rss/fetcher.ts` one, which wraps the client version.

## jm-daily 插件 (JMComic 每日推荐)

`src/plugins/jm-daily/` 定时从 JMComic 拉取榜单并发送到 Discord/Telegram/OneBot11。

- 依赖 `jmcomic-crawler`（npm，ESM-only）。项目编译为 CJS，因此该包通过 `patchedDependencies`（`patches/jmcomic-crawler@2.7.5.patch`）在 exports 中补上了 `require` 条件，`bun install` 时自动应用。**不要删除该 patch**，否则 `require("jmcomic-crawler")` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。升级版本时需同步替换为对应版本的 patch 文件并改 `package.json` 的 `patchedDependencies`。
- `src/plugins/jm-daily/jm.ts` 使用 `JmApiClient.reqApi("/album?id=")` 拿原始数据而非 `getAlbumDetail()`，因为上游包的 `JmApiAdaptTool.parseEntity` 用单对象调用位置参数构造函数，实体字段会错乱（`name` 等全为 undefined）。
- 榜单来源（v2.7.5+）：日榜 `client.dayRanking(1)`、周榜 `client.weekRanking(1)`、月榜 `client.monthRanking(1)`（三者等价于 `categoriesFilter` + 对应时间常量 + `ORDER_BY_VIEW`）；人气榜/最新榜仍用 `categoriesFilter`（`TIME_ALL` + `ORDER_BY_VIEW`/`ORDER_BY_LATEST`）。日榜偶发返回空，插件自动回退 `week → month → popular`。
- 标签过滤：`options.excludeTags`（字符串数组），本子标签命中任意一个即跳过发送；定时任务和 `/jm` 命令都会过滤。
- 数量补足：`fetchDailyAlbumIds` 跨页拉取（每源最多 5 页防死循环）；`collectTopAlbums`（index.ts）跳过被去重/详情失败/excludeTags 排除的本子并继续往后拉取，直到攒够 `limit` 本（详情逐个抓取、凑满即停；窗口每次扩大 `limit`，上限 100，防循环 10 轮）。
- 去重：`data/bot.db` 的 `jm_daily_sent` 表记录已发送的 album id，同一本子只发送一次（`historyDays` 默认 30 天清理）。
- 目标解析：只发送 `options.targets` 里显式配置的目标（`telegram`/`discord`/`onebot`），**不回退到 `groups` 的频道**；未配置 `targets` 时定时任务和 `/jm` 命令都不发送。
- 手动命令：`/jm <source> [数量]`（Telegram/OneBot 文本命令，Discord 为 `/jm` 斜杠命令），`source` 支持 `daily`/`week`/`month`/`monthly`/`popular`/`latest` 及中文别名（如 `/jm 月榜 10`）。手动命令不过滤去重（按请求发 top N），只发送到配置的 targets，并写入去重记录。Telegram 文本消息钩子（`onTelegramMessage`）在 `src/index.ts` 中接线；OneBot 消息钩子（`onOneBotMessage`）同样在 `src/index.ts` 接线（审批命令之前）；Discord 斜杠命令由插件自注册 `interactionCreate` 处理（同 ai-chat 模式），纯文本 `/jm` 依赖 ai-chat 的 `messageCreate` 监听器转发 `onDiscordMessage`。
- 运行时必须是 **Bun**（`bun run dev` / `bun run dist/index.js`）：项目依赖 `bun:sqlite`，`node dist/index.js` 无法运行。

## Import path convention

All internal imports use the `@/` alias (`@/` maps to `src/`). This avoids fragile relative paths like `../../../foo`:
```typescript
import { getConfig } from '@/config';          // instead of '../config'
import { PluginDefinition } from '@/plugins/types'; // instead of '../../../plugins/types'
```

Configured via `tsconfig.json` `baseUrl` + `paths`. Built with `tsc` + `tsc-alias` (resolves aliases to relative paths in `dist/`).

## TypeScript conventions

- Use `const`, never `var`.
- Avoid `any`; narrow types first, then use explicit assertions.
- Prefer `type` over `interface` unless declaration merging is needed.
- No `enum` — use literal unions.
- Public API functions must declare return types explicitly.
- Files: `kebab-case.ts`.
- All internal imports use the `@/` alias; sibling files in the same directory may use `./x`. No `../../foo`.
- Log through `logger` from `@/logger` (`logger.info('Module', ...)`), not `console`.
