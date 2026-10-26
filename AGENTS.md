# AGENTS.md

## Environment

- **Runtime**: Bun (`packageManager: bun`). Always use `bun install`, `bun run <script>`.
- **Nix-first**: If the host lacks `bun`, `node`, etc., create or update `flake.nix` (`nix develop` / `nix shell`) instead of assuming global installs.
- **No npm/pnpm/yarn**.

## Commands

```bash
bun install          # install deps
bun run dev          # bun run src/index.ts (runs TS directly, no hot reload)
bun run build        # tsc && cp src/web/ui.html dist/web/ui.html
bun run start        # bun run dist/index.js
bun run build:binary # bun build --compile → dist/shit-bot (single-file binary)
bun run test         # bun test src — unit/integration tests (*.test.ts next to the code)
bun run typecheck    # tsc --noEmit -p tsconfig.test.json — type-checks src including tests
```

Tests live next to the code as `src/**/*.test.ts`; `tsconfig.json` excludes them so they never land in `dist/`. Tests use `initDatabase(':memory:')` for an isolated DB and `setConfigForTesting(raw)` instead of a config file, and stub `globalThis.fetch` for LLM calls.

Build copies `src/web/ui.html` into `dist/web/` because tsc does not copy non-`.ts` assets. Any other non-`.ts` asset the runtime needs must either be copied the same way or embedded as a TS string constant.

## Architecture

- Single Bun process, not serverless/Workers. (`wrangler.jsonc` and the `deploy`/`preview` scripts are unrelated to the bot runtime.)
- `src/index.ts` — entrypoint: inits SQLite → renderer → Twitter client (optional; the bot can run AI chat + WebUI only) → Discord/Telegram bots → slash commands + AI message listener → web server → first poll + cron polling.
- `src/config.ts` — config loader: first match of `data/config.{yaml,yml,toml,json}`, then `config.{yaml,yml,toml,json}` in the project root; merges env vars; clamps/validates.
- `src/storage.ts` — `bun:sqlite` (built into Bun, no native addon). DB at `data/bot.db`, WAL mode. Core tables: `sent_tweets`, `image_cache`, `sent_messages`, `sent_tg_messages`, `pending_approvals`, `dead_letters`. AI tables come from the migrations in `src/ai/db/` (the pre-migration `ai_memories` / `ai_conversations` / `channel_messages` are imported once and renamed `_legacy_*`).
- `src/bots/` — Discord (`discord.js`) and Telegram (`telegraf`) clients. AI chat is wired to **Discord only**.
- `src/ai/` — AI persona (memecat) over an OpenAI-compatible `/chat/completions` API. Platform-neutral logic lives here; discord.js-specific code is in `src/bots/discord*.ts` and `src/ai/discord-{adapter,runtime}.ts`.
  - Chat: `chat.ts` (tool loop, image inlining, reply JSON + reactions), `context.ts` (persona prompt + core memory blocks), `tools.ts` (tool schemas + dispatch), `llm-client.ts` (shared HTTP client: retries/timeouts, per-purpose token accounting in `llm_usage`, `jsonCompletion` with `response_format` fallback), `websearch.ts`, `time.ts` (UTC+8).
  - Data in: `ingest.ts` (every message → `messages`, keyed by user ID), `identity.ts` (users / members / name history), `mentions.ts` (`<@id>` → people), `history-sync.ts` (backfill / gap fill), `presence.ts`, `intents.ts` (privileged intent auto-detection).
  - Memory: `memory/` (store, retrieval, extraction windows, profiles, stats, slash commands), `vector/` (embedder + adaptive sqlite-vec / JS backend), `persona/` + `lore.ts` (hand-written T0 layer).
  - Relationship & behaviour: `affinity.ts`, `mood.ts`, `appraise.ts` (post-reply appraisal job), `proactive.ts` (interjection gate / score / judge / feedback).
  - Jobs & lifecycle: `worker.ts` (persistent `jobs` queue + schedulers; job types are only claimed while their feature is enabled in the *runtime* config), `retention.ts`, `forget.ts` (`/forget-me`), `forget-guard.ts` (salted-hash tombstones that stop re-import of deleted messages + a "forget epoch" that async jobs check before writing), `untrusted.ts` (structural isolation of untrusted text in prompts: random-tag data fences, name/text cleaning), `command-registry.ts` + `*-commands.ts` (AI slash commands, imported via `commands.ts`).
- User-facing AI docs live in `docs/ai/` (tutorial, persona/lore, algorithms, use cases, upgrade & migration, operations). README only keeps a summary that links there — keep numbers and rules in `docs/ai/` consistent with the code when you change behaviour.
- `src/ai/db/` — versioned schema migrations for AI tables (`schema.ts` holds the list, `migrate.ts` the runner, `meta.ts` a small `kv_meta` store). `initDatabase()` runs them after the core tables; a failed AI migration only disables AI memory features (`isAiSchemaReady()`), never the tweet pipeline. Append new migrations; never edit a released one.
- `src/twitter/` — X/Twitter API via `twitter-openapi-typescript`; supports cookie auth or username/password login with TOTP.
- `src/approval.ts` — multi-admin approval flow (Telegram inline keyboard + Discord buttons).
- `src/web/server.ts` — HTTP server on configurable port (default 3000). Serves `ui.html` + REST API for config CRUD.
- Config secrets are **never committed** — `config.yaml/json/toml` are in `.gitignore`.

## Key gotchas

- Use the `bun:sqlite` API (`db.run`, `db.query(...).get/all`, `db.prepare`, `db.transaction`) — not `better-sqlite3`.
- `bun:sqlite`'s `.changes` includes rows changed by triggers. `messages` and `memories` have FTS sync triggers, so count rows with `SELECT COUNT(*)` before deleting instead of trusting `.changes` (it is fine as a `> 0` check).
- `bun test` runs all files in one process: module-level state (registered job handlers, schedulers, caches) leaks between test files. Reset what you depend on in `beforeEach`, and don't assume a handler is unregistered.
- Background jobs that call an LLM must re-check that their subject still exists (message not deleted, user not `/forget-me`'d or opted out) after the call returns and before writing.
- Config file format is auto-detected by extension. Saving via the API writes back in the same format for YAML/JSON; a TOML config can be loaded but **not** saved (save throws). On `EROFS` (read-only mount in Docker) the save falls back to `data/`.
- When editing config via API, masked secrets (`••••••••`) are treated as "no change" — the existing value is preserved. Every new secret field must be added to `sanitizeConfigForAPI` in `src/web/server.ts` by hand, and restored in the `PUT /api/config` handler.
- AI config is normalized by `normalizeAiConfig()` (defaults, clamps, env overrides) and is idempotent; `PUT /api/config` deep-merges the incoming `ai` patch and re-normalizes it, so partial nested objects keep their defaults. New AI settings belong there, not inline in `buildConfig()`.
- `fetchAllTweets` exists in both `src/twitter/client.ts` and `src/rss/fetcher.ts`; `index.ts` imports the `rss/fetcher.ts` one, which wraps the client version.

## TypeScript conventions

- Use `const`, never `var`.
- Avoid `any`; narrow types first, then use explicit assertions.
- Prefer `type` over `interface` unless declaration merging is needed.
- No `enum` — use literal unions.
- Public API functions must declare return types explicitly.
- Files: `kebab-case.ts`.
- Keep imports in a consistent order; the repo has no ESLint/Prettier config yet — match existing import style.
