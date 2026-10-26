# JM 每日推荐插件

jm-daily 是内置插件，定时从 JMComic 拉取榜单，将本子推荐搬运到 Discord / Telegram / QQ(OneBot11)，也支持 `/jm` 命令手动触发。

## 启用

在 `config.yaml` 中配置：

```yaml
plugins:
  - name: jm-daily
    enabled: true
    options:
      cron: "0 20 * * *"
      runOnStart: true
      source: daily
      limit: 5
      sendImage: true
      header: "📚 JM 今日推荐"
      dedupe: true
      historyDays: 30
      excludeTags:
        - "全彩"
        - "无修正"
      targets:
        telegram: ["-1001234567890"]
        discord: ["1234567890"]
        onebot: [123456789]
```

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | `boolean` | `true` | 是否启用 |
| `cron` | `string` | `0 20 * * *` | node-cron 表达式（服务器本地时区），默认每天 20:00 |
| `runOnStart` | `boolean` | `true` | 启动后是否立即执行一次 |
| `source` | `string` | `daily` | 数据源，见下方来源列表 |
| `limit` | `number` | `5` | 每次最多搬运的本子数量（1–50） |
| `sendImage` | `boolean` | `true` | 是否下载并附带封面图 |
| `header` | `string` | `📚 JM 今日推荐` | 发送时的标题头 |
| `dedupe` | `boolean` | `true` | 是否去重（同一本子只发送一次） |
| `historyDays` | `number` | `30` | 去重记录保留天数 |
| `excludeTags` | `string[]` | `[]` | 需要排除的标签：本子标签命中任意一个即跳过发送 |
| `targets` | `object` | — | 发送目标，见下方 |

### 数据源（source）

| 值 | 说明 |
|------|------|
| `daily` | 今日榜（默认，v2.7.5+ 专用 `dayRanking` API） |
| `week` | 周榜 |
| `month` | 月榜 |
| `popular` | 总人气 |
| `latest` | 最新上架 |

`daily` 偶发返回空，插件会自动回退 `week → month → popular`。

### excludeTags - 排除标签

```yaml
excludeTags:
  - "全彩"
  - "无修正"
```

配置后，本子详情标签命中任意一个即**跳过发送**（定时任务和 `/jm` 命令都会过滤），被过滤掉的数量会**自动往后补齐**（跨页拉取榜单，直到凑满 `limit` 本或榜单取尽）。可用于过滤不想要的内容（如特定题材、汉化组标签等）。

### targets - 发送目标

```yaml
targets:
  telegram: ["-1001234567890"]   # Telegram chat id（群/频道）
  discord: ["1234567890"]        # Discord channel id
  onebot: [123456789]            # OneBot 群号
```

**必须显式配置 `targets` 才会发送**，不会回退到 `groups` 的频道。未配置 `targets` 时，定时任务和 `/jm` 命令都不会发送任何内容。

## 手动命令

- Telegram / OneBot 文本命令：`/jm <source> [数量]`
- Discord 斜杠命令：`/jm`（`source` 必填，`limit` 选填）

`source` 支持以下别名（大小写不敏感）：

| 标准值 | 别名 |
|------|------|
| `daily` | `day`、`日`、`日榜` |
| `week` | `weekly`、`周`、`周榜` |
| `month` | `monthly`、`月`、`月榜` |
| `popular` | `hot`、`人气` |
| `latest` | `new`、`最新` |

示例：`/jm 月榜 10`、`/jm week 3`。

手动命令按请求抓取 top N（**不过滤去重**），只发送到配置的 `targets`，发送成功后仍会写入去重记录；被 `excludeTags` 过滤的数量会自动往后补齐。Discord 上纯文本 `/jm` 依赖 ai-chat 插件的消息监听转发。

## 去重

已发送的本子 album id 记录在 `data/bot.db` 的 `jm_daily_sent` 表中，同一本子只发送一次（定时任务按此过滤）。记录按 `historyDays` 定期清理。

定时任务跳过已发送的本子后，也会继续往后拉取榜单，直到凑满 `limit` 本。
