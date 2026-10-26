# X/Twitter Monitor Bot

自动监控 X/Twitter 用户发帖，通过 Discord / Telegram / QQ(OneBot11) 推送到群组/频道。

## 功能特性

- **多平台推送**: Discord Embed、Telegram HTML、QQ 群(OneBot11)
- **推文渲染**: SVG→PNG 渲染为图片发送（`sharp`）
- **审批系统**: 多管理员审批，支持 Telegram inline keyboard / Discord buttons / OneBot 文本命令
- **R14 内容**: 支持将 NSFW 内容分流到独立群组
- **目标标签**: 支持自定义发送目标（如 `r14`），管理员可选择发送到特定目标
- **撤回**: 批准后可通过按钮撤回已发送的消息（所有平台）
- **RSS 订阅**: 通过 RSS 拉取推文（备选方案）
- **X to Image API**: 推文截图渲染服务
- **X/Twitter GraphQL API**: 直接获取推文，支持 Cookie 认证或密码登录
- **过滤器**: 关键词包含/排除、媒体过滤、排除转推/回复
- **插件系统**: 可热加载的插件框架，内置 AI 聊天、日志等插件
- **AI 聊天**: 支持频道内 AI 对话（配置 AI provider）
- **Web UI**: 浏览器管理配置
- **Logger**: 统一日志系统（DEBUG/INFO/WARN/ERROR）
- **SQLite**: `better-sqlite3` 持久化存储
- **定时轮询**: 可配置间隔，推文去重

## 技术栈

- **运行时**: [Bun](https://bun.sh)（`packageManager: bun`）
- **语言**: TypeScript（`@/` 路径别名）
- **构建**: `tsc` + `tsc-alias`
- **数据库**: `better-sqlite3`（原生 C++ 模块）
- **开发环境**: Nix Flakes（可选）

## 快速开始

```bash
bun install
cp config.yaml config.yaml  # 参照下方说明编辑
bun run dev                  # 开发模式（热重载）
```

## Commands

```bash
bun install          # 安装依赖
bun run dev          # tsx watch 热重载开发
bun run build        # tsc + tsc-alias + 复制静态资源
bun run start        # node dist/index.js（需先 build）
```

## 配置

支持 `config.yaml` / `config.yml` / `config.toml` / `config.json` 格式，按以下顺序查找：

```
config.yaml > config.yml > config.toml > config.json
```

也可通过环境变量覆盖（详见 AGENTS.md 或 `.env.example`）。

### 全局配置

```yaml
enableApproval: true
sendAsImage: true
pollIntervalMinutes: 5
maxPostsPerFetch: 20
maxTweetAgeMinutes: 60
debugMode: false
```

| 字段                  | 类型    | 默认值 | 说明                      |
| --------------------- | ------- | ------ | ------------------------- |
| `enableApproval`      | boolean | false  | 启用审批流程              |
| `sendAsImage`         | boolean | false  | 渲染为图片发送（SVG→PNG） |
| `pollIntervalMinutes` | number  | 5      | 轮询间隔（分钟）          |
| `maxPostsPerFetch`    | number  | 20     | 每次最多获取推文数        |
| `maxTweetAgeMinutes`  | number  | 60     | 推文最大年龄，超过跳过    |
| `debugMode`           | boolean | false  | 启用 DEBUG 级别日志       |
| `xToImageApiUrl`      | string  | -      | X to Image API 地址       |
| `xToImageApiToken`    | string  | -      | API Token                 |

### Twitter / X 认证

```yaml
twitter:
  authToken: "你的 auth_token"   # Cookie 认证（推荐）
  ct0: "你的 ct0"
  # 或使用密码登录：
  # username: "你的用户名"
  # password: "你的密码"
  # email: "你的邮箱"
  # totpSecret: "你的 TOTP Secret"
```

### Discord

```yaml
discord:
  enabled: true
  token: "YOUR_DISCORD_BOT_TOKEN"
  adminChannelId: "管理频道ID"       # 审批命令频道
  approveRoleId: "审批角色ID"         # 可选，审批权限角色
```

### Telegram

```yaml
telegram:
  enabled: true
  token: "YOUR_TELEGRAM_BOT_TOKEN"
  adminChatIds:
    - "111111111"
    - "222222222"
  parseMode: "HTML"
  apiRoot: ""                        # 代理地址（可选）
```

### OneBot (QQ)

```yaml
onebot:
  enabled: true
  url: "ws://127.0.0.1:3001"         # OneBot11 WebSocket 地址
  token: "你的令牌"                   # 访问令牌
  wsSslVerify: true                  # WSS 时是否验证证书（自签名证书设为 false）
  reconnectInterval: 5000            # 重连间隔（ms）
```

### 监控用户

```yaml
users:
  - username: "elonmusk"
    displayName: "Elon Musk"
    filters:
      keywords:
        include: ["tesla", "spacex"]
        exclude: ["ad"]
      media:
        requireMedia: false
      excludeRetweets: true
      excludeReplies: false
```

### 发送群组

支持同时配置多个发布目标（Discord / Telegram / OneBot），每个群组可配置审批频道和 R14 专用频道：

```yaml
groups:
  - name: my-group
    users:
      - username: "*"                     # * = 所有监控用户
    discord:
      channelId: "目标频道ID"
      r14ChannelId: "R14频道ID"           # NSFW 内容分流（可选）
    telegram:
      chatId: "-1001234567890"
      targets:
        r14:
          chatId: "-1009876543210"        # R14 内容目标（可选）
    onebot:
      groupId: 123456789                  # QQ 群号
      r14GroupId: 987654321               # R14 群号（可选）
    approval:
      discordAdminChannelId: "审批频道ID"  # Discord 审批通知频道
      discordApproveRoleId: ""            # Discord 审批角色 ID（可选）
      telegramAdminChatIds:               # Telegram 审批管理员
        - "111111111"
      onebotAdminGroupIds:                # QQ 审批通知群
        - "222222222"
```

### AI 聊天插件

```yaml
plugins:
  - name: ai-chat
    enabled: true
    config:
      provider: "openai"
      baseUrl: "https://api.openai.com/v1"
      apiKey: "sk-..."
      model: "gpt-4o"
      systemPrompt: "你是一个有用的助手"
      allowList:
        - "服务器ID"                       # 允许 AI 聊天的 Discord 服务器
      maxTokens: 1024
      temperature: 0.7
```

## 审批流程

启用 `enableApproval: true` 后：

1. 推文发送到管理员频道/群组（含审批按钮）
2. 管理员可点击「全部发送」「发送 R14」「拒绝」
3. 批准后推文送达目标群组，管理员消息更新为「已批准」+ 撤回按钮
4. 撤回: 点击「撤回」按钮，自动删除所有已发送的消息

### OneBot 审批命令

```
/approve <ID>   — 批准
/reject <ID>    — 拒绝
```

### Discord 斜杠命令

```
/recall message_id:<ID>   — 按消息 ID 撤回
/recall link:<URL>        — 按链接撤回
```

## 日志系统

格式: `HH:MM:SS [LEVEL] [模块] 消息`

| 级别  | 说明                                  |
| ----- | ------------------------------------- |
| DEBUG | 调试信息，仅 `debugMode: true` 时输出 |
| INFO  | 常规信息                              |
| WARN  | 警告                                  |
| ERROR | 错误                                  |

## 插件系统

内置插件存放在 `src/plugins/`，支持热加载。

外部插件可通过以下方式安装：

```yaml
plugins:
  - name: my-plugin
    github: owner/repo      # 从 GitHub 仓库安装
```

## Web UI

启动后访问 `http://localhost:3000`（默认端口），可在线查看和修改配置。

## 数据存储

数据库位置: `data/bot.db`（SQLite）

表:
- `sent_tweets` — 已发送推文记录
- `sent_discord_messages` — Discord 消息记录
- `sent_telegram_messages` — Telegram 消息记录
- `sent_onebot_messages` — OneBot 消息记录
- `pending_approvals` — 待审批记录
- `image_cache` — 图片缓存

## 环境变量

支持 `.env` 文件，环境变量会覆盖配置文件中的对应值。关键变量：

| 变量                 | 说明                      |
| -------------------- | ------------------------- |
| `DISCORD_TOKEN`      | Discord Bot Token         |
| `TELEGRAM_TOKEN`     | Telegram Bot Token        |
| `ONEBOT_URL`         | OneBot WebSocket 地址     |
| `TWITTER_AUTH_TOKEN` | Twitter auth_token Cookie |
| `TWITTER_CT0`        | Twitter ct0 Cookie        |
| `DEBUG_MODE`         | `true` 启用调试日志       |

## License

MIT
