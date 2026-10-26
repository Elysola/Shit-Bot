# 快速开始

## 环境要求

- [Bun](https://bun.sh) 1.3+（推荐）或 Node.js 24+
- 可选：Docker + Docker Compose

## 安装

```bash
git clone https://github.com/Elysola/shit-bot.git
cd shit-bot
bun install
```

## 配置

复制示例配置文件并编辑：

```bash
cp config.yaml config.yaml
```

最低配置需要以下内容：

```yaml
# 至少一个 Twitter 目标用户
users:
  - username: elonmusk
    filters:
      excludeRetweets: true

# Discord 和/或 Telegram 机器人凭证
discord:
  enabled: true
  token: YOUR_DISCORD_BOT_TOKEN

# 或
telegram:
  enabled: true
  token: YOUR_TELEGRAM_BOT_TOKEN

# OneBot(QQ)（可选）
# onebot:
#   enabled: true
#   url: "ws://127.0.0.1:3001"

# Twitter Cookie 认证
twitter:
  authToken: "your_auth_token"
  ct0: "your_ct0"

# 至少一个推送群组
groups:
  - name: my-group
    users:
      - username: "*"
    discord:
      channelId: "1234567890"
```

## 运行

```bash
# 开发模式（热重载）
bun run dev

# 构建并运行
bun run build
bun run start
```

## 日志

日志格式: `HH:MM:SS [LEVEL] [模块] 消息`

设置 `debugMode: true` 可查看 DEBUG 级别日志：

## Docker 部署

```bash
docker compose up -d
```

详见[部署指南](/guide/deployment)。
