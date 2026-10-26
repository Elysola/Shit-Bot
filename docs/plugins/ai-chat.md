# AI Chat 插件

AI Chat 是内置插件，为 Discord 机器人提供 @提及自动回复能力，支持联网搜索、长期记忆、频道历史总结等。

## 启用

在 `config.yaml` 中配置：

```yaml
plugins:
  - name: ai-chat
    enabled: true
    options:
      enabled: true
      apiUrl: https://api.openai.com/v1
      apiKey: sk-xxx
      model: gpt-4
      systemPrompt: "你是一个有帮助的助手。"
```

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | `boolean` | `false` | 是否启用 |
| `apiUrl` | `string` | `https://api.openai.com/v1` | API 地址 |
| `apiKey` | `string` | `""` | API Key |
| `model` | `string` | `gpt-3.5-turbo` | 模型名称 |
| `systemPrompt` | `string` | 默认提示词 | 系统提示词 |
| `maxTokens` | `number` | `1024` | 最大 Token 数 |
| `temperature` | `number` | `0.7` | 温度参数 |
| `allowedGuildIds` | `string[]` | `[]` | 允许的 Discord 服务器 ID（空=全部） |
| `maxToolIterations` | `number` | `8` | 工具调用最大迭代次数 |
| `reactions` | `boolean` | `true` | 是否启用表情反应 |
| `ignoreEveryoneMention` | `boolean` | `false` | 忽略 @everyone 提及 |
| `maxImageBytes` | `number` | `6291456` | 单张图片字节上限 |
| `maxTotalImageBytes` | `number` | `12582912` | 单次请求图片总字节上限 |

### webSearch - 联网搜索

```yaml
webSearch:
  enabled: true
  provider: duckduckgo     # duckduckgo | tavily | serper | brave | searxng
  apiKey: ""               # tavily / serper / brave 需要
  baseUrl: ""              # searxng 实例地址
  maxResults: 5
```

### memory - 长期记忆

```yaml
memory:
  enabled: true
  maxProfileItems: 12       # 每轮注入的画象条数
  maxProfileChars: 800      # 画像字符上限
  recentTurns: 6            # 最近对话轮次
  recallLimit: 8            # 按需检索条数
  logConversations: true    # 记录对话历史
  maxConversationsPerUser: 500
```

### summary - 频道历史总结

```yaml
summary:
  enabled: true
  maxMessagesPerChannel: 500
  defaultCount: 100
```

## Discord 命令

- `@机器人 你的问题` — @提及发起对话
- `/memory` — 查看 AI 对你的记忆
- `/delete-memory <key>` — 删除指定记忆

## 工具

AI 聊天启用后，模型可以调用以下工具：

| 工具 | 说明 |
|------|------|
| `web_search` | 联网搜索实时信息 |
| `open_url` | 读取网页正文 |
| `read_image` | 查看图片 |
| `recall_memory` | 检索历史对话 |
| `save_memory` | 保存长期记忆 |
| `update_memory` | 更新记忆 |
| `forget_memory` | 删除记忆 |
| `read_channel_history` | 读取频道聊天记录 |
