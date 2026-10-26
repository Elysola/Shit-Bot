# 开发插件

## 项目结构

```
src/plugins/<name>/
  index.ts      # 插件入口，导出 PluginDefinition
```

## 快速开始

创建 `src/plugins/my-plugin/index.ts`：

```typescript
import type { PluginDefinition } from '@/plugins/types'

export default {
  manifest: {
    name: 'my-plugin',
    version: '1.0.0',
    description: '我的插件',
    author: 'me',
  },
  init: (api) => {
    api.logger.info('插件已加载')
  },
  hooks: {
    onAfterInit: async () => {
      api.logger.info('插件初始化完成')
    },
    onDiscordMessage: async (message) => {
      if (message.content === '!ping') {
        await message.reply('pong!')
        return true // 拦截消息
      }
      return false // 放行
    },
    onAfterPoll: async (tweets) => {
      api.logger.info(`本轮获取到 ${tweets.length} 条推文`)
    },
  },
} satisfies PluginDefinition
```

## PluginDefinition 类型

```typescript
interface PluginDefinition {
  manifest: PluginManifest
  init?: (api: PluginAPI) => void | Promise<void>
  hooks?: Partial<PluginHooks>
  cronJobs?: Array<{
    schedule: string       // cron 表达式
    task: () => Promise<void>
  }>
}
```

## 从 GitHub 加载

配置 `github` 字段即可从 GitHub 仓库自动拉取：

```yaml
plugins:
  - name: translate
    github: someuser/translate-plugin
    ref: main
    enabled: true
```

系统会自动 `git clone --depth 1` 到 `data/plugins-cache/` 目录，后续启动时 `git pull` 增量更新。

## 外部目录

支持从外部目录加载插件（Docker volume 友好）：

```yaml
pluginsDir: /app/data/plugins
```

目录下每个子目录即为一个插件。
