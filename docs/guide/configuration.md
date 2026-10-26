# 配置说明

配置文件支持 `yaml`、`json`、`toml` 格式，按顺序查找 `config.yaml > config.yml > config.toml > config.json`。

## 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `users` | `UserConfig[]` | 监控的 Twitter 用户列表 |
| `discord` | `DiscordConfig` | Discord 机器人配置 |
| `telegram` | `TelegramConfig` | Telegram 机器人配置 |
| `twitter` | `TwitterConfig` | Twitter API 认证配置 |
| `webui` | `WebUIConfig` | Web 管理界面配置 |
| `enableApproval` | `boolean` | 是否启用审批机制 |
| `sendAsImage` | `boolean` | 是否将推文渲染为图片发送 |
| `debugMode` | `boolean` | 启用 DEBUG 级别日志 |
| `xToImageApiUrl` | `string` | 推文转图片 API 地址 |
| `xToImageApiToken` | `string` | 推文转图片 API Token |
| `xToImageApiTheme` | `string` | 图片主题: `light` / `dim` / `dark` |
| `imageCacheTtlMinutes` | `number` | 图片缓存时间（分钟） |
| `pollIntervalMinutes` | `number` | 轮询间隔（分钟） |
| `maxPostsPerFetch` | `number` | 每次获取最大推文数 |
| `maxTweetAgeMinutes` | `number` | 推文最大时效（分钟） |
| `groups` | `GroupConfig[]` | 推送群组配置 |
| `plugins` | `PluginConfigEntry[]` | 插件配置 |
| `pluginsDir` | `string \| string[]` | 外部插件目录 |

## users - 监控用户

```yaml
users:
  - username: elonmusk          # Twitter 用户名（不含 @）
    displayName: Elon            # 显示名称（可选）
    filters:
      keywords:
        include: [tesla, spacex]  # 包含关键词
        exclude: [ad]             # 排除关键词
      media:
        requireMedia: true        # 要求推文包含媒体
      excludeRetweets: true       # 排除转推
      excludeReplies: true        # 排除回复
```

## discord - Discord 机器人

```yaml
discord:
  enabled: true
  token: YOUR_DISCORD_BOT_TOKEN
  embedColor: "#1DA1F2"
```

## telegram - Telegram 机器人

```yaml
telegram:
  enabled: true
  token: YOUR_TELEGRAM_BOT_TOKEN
  parseMode: HTML
  apiRoot: ""                     # 自定义 API 地址（可选）
```

## onebot - QQ(OneBot11) 机器人

使用 OneBot11 协议连接 QQ 机器人（如 NapCat、LLOneBot）。

```yaml
onebot:
  enabled: true
  url: "ws://127.0.0.1:3001"      # OneBot11 WebSocket 地址
  token: "your_token"             # 访问令牌
  wsSslVerify: true               # WSS 时验证证书，自签名证书设为 false
  reconnectInterval: 5000         # 重连间隔（毫秒）
```

## twitter - Twitter 认证

支持两种认证方式，优先使用 Cookie：

```yaml
# 方式一：Cookie 认证（推荐）
twitter:
  authToken: "your_auth_token"
  ct0: "your_ct0"

# 方式二：用户名/密码登录
twitter:
  username: "your_username"
  password: "your_password"
  email: "your_email"             # 可选，部分账号需要
  totpSecret: "your_totp_secret"  # 可选，双因素认证
```

## webui - Web 管理界面

```yaml
webui:
  enabled: true
  port: 3000
  host: "0.0.0.0"
  password: "your_password"       # 留空不设密码
```

## groups - 推送群组

```yaml
groups:
  - name: my-group
    users:
      - username: "*"              # * 表示所有顶层 users
      # 或指定具体用户
      - username: elonmusk
        displayName: Elon
        filters:
          media:
            requireMedia: true
    discord:
      channelId: "1234567890"
      r14ChannelId: "1234567891"   # R14 评级推送频道（可选）
    telegram:
      chatId: "-1001234567890"
      targets:
        r14:
          chatId: "-100_R14_CHAT_ID"
    onebot:
      groupId: 123456789            # QQ 群号
      r14GroupId: 987654321         # R14 群号（可选）
    approval:
      discordAdminChannelId: "1234567892"
      discordApproveRoleId: "1234567893"
      telegramAdminChatIds:
        - "111111111"
      onebotAdminGroupIds:          # QQ 审批通知群（可选）
        - "222222222"
    blockedUsers: []               # 该群组拉黑的用户
```

### 用户展开规则

- 群组 `users` 中使用 `username: "*"` 会展开为顶层 `users` 列表中的所有用户
- 群组内也可以写具体用户名，覆盖该用户在群组内的过滤器
- 用户被推送到群组的前提是满足群组过滤器和用户自身过滤器

## 审批系统

启用 `enableApproval: true` 后：

1. 推文发送到管理员频道/群组（内联按钮：「全部发送」「发送 R14」「拒绝」）
2. 管理员批准后推文送达目标群组，管理员消息更新为「已批准」并添加撤回按钮
3. 点击「撤回」按钮（或 Discord `/recall` 命令）自动删除所有已发送的消息

### 群组审批配置

```yaml
groups:
  - name: my-group
    approval:
      discordAdminChannelId: "1234567892"     # Discord 审批通知频道
      discordApproveRoleId: "1234567893"      # 审批权限角色 ID（可选）
      telegramAdminChatIds:                   # Telegram 审批管理员
        - "111111111"
      onebotAdminGroupIds:                    # QQ 审批通知群
        - "222222222"
```

### OneBot 审批命令

```
/approve <审批ID>   — 批准
/reject <审批ID>    — 拒绝
```

### Discord 斜杠命令

```
/recall message_id:<ID>   — 按消息 ID 撤回
/recall link:<URL>        — 按链接撤回
```

## 日志系统

日志格式: `HH:MM:SS [LEVEL] [模块] 消息`

| 级别 | 说明 |
|------|------|
| DEBUG | 调试信息，仅 `debugMode: true` 时输出 |
| INFO | 常规信息 |
| WARN | 警告 |
| ERROR | 错误 |

## 环境变量覆盖

以下环境变量可覆盖配置文件中的敏感字段。环境变量优先级高于配置文件。

| 环境变量 | 对应配置 |
|----------|----------|
| `DISCORD_TOKEN` | `discord.token` |
| `TELEGRAM_TOKEN` | `telegram.token` |
| `ONEBOT_URL` | `onebot.url` |
| `ONEBOT_TOKEN` | `onebot.token` |
| `ONEBOT_SECRET` | `onebot.secret` |
| `ONEBOT_ENABLED` | `onebot.enabled` |
| `TWITTER_AUTH_TOKEN` | `twitter.authToken` |
| `TWITTER_CT0` | `twitter.ct0` |
| `TWITTER_USERNAME` | `twitter.username` |
| `TWITTER_PASSWORD` | `twitter.password` |
| `TWITTER_EMAIL` | `twitter.email` |
| `TWITTER_TOTP_SECRET` | `twitter.totpSecret` |
| `X_TO_IMAGE_API_URL` | `xToImageApiUrl` |
| `X_TO_IMAGE_API_TOKEN` | `xToImageApiToken` |
| `DEBUG_MODE` | `debugMode` |
| `AI_API_URL` | `plugins[].options.apiUrl` |
| `AI_API_KEY` | `plugins[].options.apiKey` |
| `AI_WEB_SEARCH_API_KEY` | `plugins[].options.webSearch.apiKey` |
