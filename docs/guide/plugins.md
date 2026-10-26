# 插件系统

Shit Bot 支持插件化扩展，插件有三种来源：

## 插件生命周期

每个插件遵循以下生命周期：

```
加载 → init() → onConfigLoaded() → onBeforeInit() → onAfterInit() → 运行中 → onBeforeShutdown()
```

- **init(api)**：插件初始化，接收 `PluginAPI` 实例
- **onConfigLoaded(config)**：配置加载完成后
- **onBeforeInit()**：各模块初始化前
- **onAfterInit()**：所有初始化完成后（适合注册监听器）
- **onBeforePoll() / onAfterPoll()**：每次轮询前后
- **onBeforeShutdown()**：进程关闭前

## 钩子列表

| 钩子 | 触发时机 | 参数 |
|------|----------|------|
| `onConfigLoaded` | 配置加载完成 | `AppConfig` |
| `onBeforeInit` | 各模块初始化前 | - |
| `onAfterInit` | 初始化完成 | - |
| `onBeforeShutdown` | 进程关闭前 | - |
| `onBeforePoll` | 每次轮询前 | - |
| `onAfterPoll` | 每次轮询后 | `Tweet[]` |
| `onBeforeApproval` | 审批发送前 | `Tweet, GroupConfig` |
| `onBeforeTweetSend` | 推文发送前 | `GroupConfig` |
| `onAfterTweetSend` | 推文发送后 | `Tweet, GroupConfig` |
| `onApprovalResult` | 审批完成 | `Tweet, GroupConfig, approved, adminName, targetTag` |
| `onDiscordMessage` | Discord 消息 | `Message` → `boolean`（是否拦截） |
| `onTelegramMessage` | Telegram 消息 | `Context` → `boolean`（是否拦截） |

## 插件配置

```yaml
plugins:
  - name: ai-chat              # 插件名，对应 src/plugins/<name>/
    enabled: true
    options:
      key: value                # 插件自定义配置

  - name: translate             # 从 GitHub 源加载
    github: someuser/translate-plugin
    ref: main
    enabled: true
    options:
      targetLang: zh

pluginsDir: /app/data/plugins   # 外部插件目录（可选）
```

## PluginAPI

插件 `init()` 接收的 API 对象：

```typescript
interface PluginAPI {
  logger: {
    info(msg: string): void
    warn(msg: string): void
    error(msg: string): void
  }
  getConfig(): AppConfig
  getStorage(): Database
  getDiscordClient(): Client | null
  getTelegramBot(): Telegraf | null
}
```
