# X/Twitter Monitor Bot

自动监控 X/Twitter 用户发帖，通过 Discord/Telegram Bot 推送到群组/频道；内置一个住在 Discord 服务器里的 AI 角色 **memecat**（见下方「AI：memecat」和 [`docs/ai/`](docs/ai/README.md)）。

## 功能特性

- 通过 X/Twitter GraphQL API 直接获取推文
- 支持 Cookie 认证 或 用户名/密码/TOTP 登录
- 支持关键词过滤（包含/排除）
- 支持媒体过滤（图片/视频）
- 支持排除转推/回复
- 推文渲染为图片发送
- 多管理员审批机制
- SQLite 持久化存储
- Discord Embed 推送
- Telegram HTML 格式推送
- 定时轮询，可配置间隔
- **AI 角色（Discord）**：人设卡 + 设定集、对每个成员的长期记忆、服务器记忆、好感度、情绪、主动插话、@ 解析、可选的向量检索

## 安装

运行时是 [Bun](https://bun.sh)（≥ 1.3），不需要 Node 或 C++ 编译工具链（SQLite 用的是 Bun 内置的 `bun:sqlite`）。

```bash
bun install
cp config.example.yaml config.yaml   # 或 cp config.example.json config.json / cp config.example.toml config.toml
# 编辑复制出来的文件填入配置（扩展名要和内容格式一致）
```

## 配置说明

复制一份示例并**保留它的扩展名**（`config.example.yaml` → `config.yaml`，`.json` → `config.json`，`.toml` → `config.toml`），按需修改：解析器按扩展名选择，TOML 内容放进 `config.yaml` 会启动失败。TOML 配置能读取但 WebUI 不能保存，想用 WebUI 改配置请选 YAML 或 JSON。查找顺序：`data/config.{yaml,yml,toml,json}` → 项目根目录的 `config.{yaml,yml,toml,json}`，用第一个找到的。三份示例内容一致，每个字段都有注释（JSON 除外）。

### users - 监控用户

```json
{
  "users": [
    {
      "username": "elonmusk",
      "displayName": "Elon Musk",
      "filters": {
        "keywords": {
          "include": ["tesla", "spacex"],
          "exclude": ["ad", "sponsored"]
        },
        "media": { "requireMedia": false },
        "excludeRetweets": true,
        "excludeReplies": false
      }
    }
  ]
}
```

| 字段                         | 类型     | 说明                              |
| ---------------------------- | -------- | --------------------------------- |
| `username`                   | string   | X/Twitter 用户名（不含 @）        |
| `displayName`                | string   | 显示名称（可选）                  |
| `filters.keywords.include`   | string[] | 必须包含的关键词（空数组=不限制） |
| `filters.keywords.exclude`   | string[] | 排除的关键词                      |
| `filters.media.requireMedia` | boolean  | 是否只推送包含媒体的推文          |
| `filters.excludeRetweets`    | boolean  | 是否排除转推                      |
| `filters.excludeReplies`     | boolean  | 是否排除回复                      |

### discord - Discord 配置

```json
{
  "discord": {
    "enabled": true,
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "channelId": "YOUR_CHANNEL_ID",
    "adminChannelId": "YOUR_ADMIN_CHANNEL_ID",
    "embedColor": "#1DA1F2"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用 Discord |
| `token` | string | Bot Token |
| `channelId` | string | 目标频道 ID |
| `adminChannelId` | string | 管理员审批频道 ID（可选） |
| `embedColor` | string | Embed 颜色（十六进制） |
| `privilegedIntents.members` | `auto` \| `on` \| `off` | 成员列表特权 intent（昵称、角色、进出服务器）；`auto` = 按开发者后台的开关自动决定 |
| `privilegedIntents.presences` | `auto` \| `on` \| `off` | 在线状态特权 intent（在线状态、正在玩什么）；同上 |

### telegram - Telegram 配置

```json
{
  "telegram": {
    "enabled": true,
    "token": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "-1001234567890",
    "adminChatIds": ["111111111", "222222222"],
    "parseMode": "HTML",
    "apiRoot": ""
  }
}
```

| 字段           | 类型     | 说明                               |
| -------------- | -------- | ---------------------------------- |
| `enabled`      | boolean  | 是否启用 Telegram                  |
| `token`        | string   | Bot Token（从 @BotFather 获取）    |
| `chatId`       | string   | 目标群组/频道 ID                   |
| `adminChatIds` | string[] | 管理员 Chat ID 数组（审批用）      |
| `parseMode`    | string   | 消息格式（`HTML` 或 `Markdown`）   |
| `apiRoot`      | string   | Telegram API 代理地址（留空=直连） |

### twitter - X/Twitter 认证配置

提供以下两种方式之一进行认证：

**方式一：Cookie 认证（推荐）**

从浏览器中提取 `auth_token` 和 `ct0` 两个 Cookie：

```json
{
  "twitter": {
    "authToken": "你的 auth_token",
    "ct0": "你的 ct0"
  }
}
```

**方式二：用户名/密码登录**

提供 X 账号的用户名和密码，程序启动时会自动登录获取 Cookie：

```json
{
  "twitter": {
    "username": "你的用户名",
    "password": "你的密码",
    "email": "你的邮箱",
    "totpSecret": "你的 TOTP Secret"
  }
}
```

| 字段         | 类型   | 说明                                                      |
| ------------ | ------ | --------------------------------------------------------- |
| `authToken`  | string | Cookie `auth_token`（方式一必填）                         |
| `ct0`        | string | Cookie `ct0`（方式一必填）                                |
| `username`   | string | X/Twitter 用户名（方式二必填）                            |
| `password`   | string | X/Twitter 密码（方式二必填）                              |
| `email`      | string | 注册邮箱（登录遇到验证时使用）                            |
| `totpSecret` | string | TOTP 二次验证密钥（Base32 格式，开启 2FA 时使用）         |

> **注意**：也可以通过环境变量配置，详见下方「环境变量」章节。

### 全局配置

```json
{
  "enableApproval": true,
  "sendAsImage": true,
  "pollIntervalMinutes": 5,
  "maxPostsPerFetch": 20,
  "maxTweetAgeMinutes": 60
}
```

| 字段                  | 类型    | 默认值 | 说明                                |
| --------------------- | ------- | ------ | ----------------------------------- |
| `enableApproval`      | boolean | false  | 是否启用审批（需配置 adminChatIds） |
| `sendAsImage`         | boolean | false  | 是否渲染为图片发送                  |
| `pollIntervalMinutes` | number  | 5      | 轮询间隔（分钟）                    |
| `maxPostsPerFetch`    | number  | 20     | 每次最多获取推文数                  |
| `maxTweetAgeMinutes`  | number  | 60     | 推文最大年龄（超过则跳过）          |

## 获取 Token

### X/Twitter Cookie

**获取 `auth_token` 和 `ct0`：**

1. 在浏览器中登录 https://x.com
2. 打开开发者工具（F12）→ Application → Cookies → `https://x.com`
3. 找到并复制 `auth_token` 和 `ct0` 的值
4. 填入 `config.json` 的 `twitter` 部分

> **提示**：Cookie 有效期较长，但更换密码或主动登出会失效。失效后需重新获取。

**使用用户名/密码登录（可选）：**

如果不想手动提取 Cookie，可以在 `config.json` 中填入 `username` 和 `password`（以及可选的 `email`、`totpSecret`），程序启动时会自动登录并打印获取到的 Cookie。

也可以使用 `totpSecret` 字段支持 2FA 二次验证（Base32 格式）。

### Discord Bot Token

1. 访问 https://discord.com/developers/applications
2. 创建应用 → Bot → 复制 Token
3. 邀请 Bot 到服务器，授予 `Send Messages` 和 `Embed Links` 权限
4. 右键频道 → 复制频道 ID

### Telegram Bot Token

1. 在 Telegram 搜索 @BotFather
2. 发送 `/newbot` 创建 Bot
3. 复制 Token
4. 获取 Chat ID：发送消息给 Bot，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`

### Telegram Admin Chat ID

1. 给 Bot 发送任意消息
2. 访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. 在返回的 JSON 中找到 `chat.id`

## 运行

```bash
# 开发模式（直接运行 TypeScript）
bun run dev

# 生产模式
bun run build
bun run start

# 单文件可执行程序（dist/shit-bot）
bun run build:binary

# 测试与类型检查
bun run test
bun run typecheck
```

## 审批功能

启用 `enableApproval` 后，支持 Telegram 和 Discord 双平台审批：

**Telegram 审批**：配置 `telegram.adminChatIds`
**Discord 审批**：配置 `discord.adminChannelId`

流程：

1. 推文同时发送给 Telegram 管理员和 Discord 审批频道
2. 管理员点击 ✅ 或 ❌ 按钮
3. 任意一位管理员审批通过后，推文发送到目标群组/频道
4. 其他管理员收到审批结果通知（包含审批人）

> 可以只配置一个平台的管理员，也可以同时配置两个平台。

## AI：memecat

开启 `ai.enabled` 后，bot 在 Discord 里变成一个有固定人格的群成员（默认是猫娘 **memecat**）：被 @、被回复时说话，平时潜水观察，偶尔自己插一句；记得每个人说过的事，对不同的人态度不同，自己也有心情起伏。AI 只接入了 Discord。

**完整文档在 [`docs/ai/`](docs/ai/README.md)**：

| 文档 | 内容 |
|---|---|
| [使用教程](docs/ai/getting-started.md) | 从零部署、首次启动会发生什么、日常使用、常见调整、开启向量检索、Docker 注意事项 |
| [人设卡与设定集](docs/ai/persona-and-lore.md) | 字段说明、写一个新角色、按服务器分配、调参经验、设定集格式 |
| [工作原理与算法](docs/ai/algorithms.md) | 入库、历史回望、记忆提炼与校验、分层记忆、检索打分、向量三段式、画像、好感、情绪、主动插话、后台任务、删除一致性 |
| [适用场景与局限](docs/ai/use-cases.md) | 适合什么、真实对话示例、局限、不适合什么 |
| [升级与数据迁移](docs/ai/upgrade-and-migration.md) | 升级步骤、旧数据怎么转换、废弃配置对照、回滚 |
| [运维、隐私与排错](docs/ai/operations.md) | 成本与体积、日志、常用查询、隐私与删除范围、故障降级、验收脚本 |

### 功能一览

| 功能 | 说明 |
|---|---|
| 人格 | 人设卡（`data/personas/*.yaml`）+ 设定集（`data/lore/`），改文件即时生效 |
| 对每个人的长期记忆 | 被动观察所有成员在所有可见频道的消息（不只是和 bot 聊天时），后台提炼成记忆；按用户 ID 存储，改名不丢 |
| 服务器记忆 / 自我记忆 | 群里的梗、规则、大事；bot 自己说过的观点和承诺 |
| @ 解析 | `<@ID>`、角色、频道解析成具体对象；回复只提醒本轮出现过的人，`@everyone` 不触发、不提醒 |
| 历史回望 | 首次回望最近 30 天，之后每次启动 / 重连补上停机期间的消息 |
| 好感度 | 6 档，由独立的"内心评估"模型站在人设立场判断，有单次 / 每日上限兜底；只影响语气和态度，从不展示数值；评估输入做了防提示词注入的结构隔离 |
| 情绪 | 效价 × 唤醒度，有基线和作息曲线，随事件变化、随时间回归 |
| 主动插话 | 被叫到名字、有问题没人答、聊到感兴趣的话题时自己插一句；有冷却、上限、反馈自适应、`/shh` |
| 向量检索（可选） | 配了向量模型就做语义检索；sqlite-vec 优先，JS 兜底，不需要单独的向量数据库服务 |

### 最小配置

Discord 开发者后台必须打开 **Message Content Intent**（Server Members / Presence Intent 可选，bot 会自动检测）。只用 AI、不做推文推送时：

```yaml
twitter:
  enabled: false            # 否则必须配置 groups
discord:
  enabled: true
  token: YOUR_DISCORD_BOT_TOKEN
ai:
  enabled: true
  apiUrl: https://api.openai.com/v1   # 任何 OpenAI 兼容接口
  apiKey: sk-...
  model: gpt-4o-mini
  allowedGuildIds: ["你的服务器ID"]    # 空 = 所有服务器
  memory:
    enabled: true
```

其余配置都有默认值，示例配置里每个字段都有注释。WebUI 目前没有 AI 设置界面，请直接改配置文件。

### 斜杠命令

| 命令 | 谁能用 | 作用 |
|---|---|---|
| `/memory` | 任何人 | 查看 bot 关于自己的全部记忆（只有自己能看到） |
| `/forget id:` | 任何人 | 删除一条关于自己的记忆 |
| `/callme 称呼:` | 任何人 | 设定希望被怎么称呼 |
| `/affinity` | 任何人 | 看看 bot 现在对自己是什么感觉（不显示数值） |
| `/optout` / `/optin` | 任何人 | 停止 / 恢复记录自己的消息 |
| `/forget-me` | 任何人（也可以私信使用） | 删除自己的全部数据，按钮二次确认 |
| `/shh 分钟: 范围:` | 有"管理消息"权限的人 | 暂停主动插话 |

### 隐私

**这一节不构成法律意见。** 被动观察所有成员的消息、读取在线状态、跨服务器共享记忆是否合规，需要服务器所有者自己确认，并告知成员（[告示模板](docs/ai/operations.md#成员告示模板)）。数据都在本机 `data/bot.db`，会发送给你配置的模型服务商。敏感话题只接受本人说的、只在和本人聊天时使用；密码、证件号、银行卡号、手机号、邮箱、详细住址永远不会写进记忆。`/forget-me` 的删除范围、保留期、防回灌机制见[运维、隐私与排错](docs/ai/operations.md#隐私)。

## 数据存储

使用 SQLite（`bun:sqlite`）存储：

- 数据库位置：`data/bot.db`
- 推文推送：`sent_tweets` 等表，自动清理 30 天前的记录
- AI：`users` / `guild_members` / `name_history`（身份）、`messages` + `messages_fts`（消息与全文索引）、`memories` + `memories_fts`（记忆）、`profiles`、`relationships` / `affinity_events`（好感）、`mood_state` / `mood_events`（情绪）、`user_stats`、`activity_sessions`、`interaction_edges`、`channels`、`vectors`、`jobs`、`llm_usage`。由版本化迁移自动建立（`schema_migrations`）；升级前的旧版 AI 数据会自动导入，旧表改名为 `_legacy_*` 保留

查看记录：

```bash
sqlite3 data/bot.db "SELECT * FROM sent_tweets ORDER BY sent_at DESC LIMIT 10"
```

## 过滤规则说明

| 规则                 | 说明                       |
| -------------------- | -------------------------- |
| `keywords.include`   | 推文必须包含至少一个关键词 |
| `keywords.exclude`   | 推文包含任一关键词则跳过   |
| `media.requireMedia` | 只推送包含媒体的推文       |
| `excludeRetweets`    | 跳过转推                   |
| `excludeReplies`     | 跳过回复                   |

## 环境变量

可选，在 `.env` 文件中配置：

```env
DISCORD_TOKEN=your_discord_bot_token
TELEGRAM_TOKEN=your_telegram_bot_token

# AI（可选）
AI_API_URL=https://api.openai.com/v1
AI_API_KEY=your_ai_api_key
AI_EXTRACTOR_API_KEY=       # 后台提炼单独用的 key
AI_EMBEDDING_API_KEY=       # 向量模型的 key
AI_WEB_SEARCH_API_KEY=      # tavily / serper / brave 的 key

# Twitter/X Cookie 认证
TWITTER_AUTH_TOKEN=your_auth_token
TWITTER_CT0=your_ct0

# Twitter/X 用户名/密码登录（可选）
# TWITTER_USERNAME=your_username
# TWITTER_PASSWORD=your_password
# TWITTER_EMAIL=your_email@example.com
# TWITTER_TOTP_SECRET=your_totp_base32_secret
```

环境变量会覆盖配置文件中的对应配置。

## License

MIT
