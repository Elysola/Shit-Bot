# 升级与数据迁移

从旧版本（只有"每人一组键值记忆 + 对话日志 + 频道消息日志"的 AI 插件）升级到现在的版本，数据会**自动迁移**，不需要手动操作。这一篇说明迁移做了什么、配置要怎么改、出问题怎么回退。

## 升级步骤

1. **停掉 bot**，**备份数据库**：`data/bot.db` 以及同目录下的 `bot.db-wal`、`bot.db-shm`（如果有）一起复制。
2. 更新代码，`bun install`（新增依赖 `sqlite-vec`，随依赖安装）。
3. 按下面的[配置变化](#配置变化)调整配置文件（不改也能启动，废弃的字段只会在日志里提示）。
4. 启动。日志里应该看到：

   ```
   [DB] AI 数据结构已迁移到 v10（本次执行: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10）
   ```

5. 首次启动会做一次历史回望（每个频道最近 30 天），并在后台慢慢提炼记忆。旧版本的记忆在迁移后立即可用。

## 配置搬到插件里

AI 现在是内置插件 `ai-chat`，配置从顶层的 `ai:` 移到了 `plugins` 列表里这个插件的 `options` 下：

```yaml
# 旧
ai:
  enabled: true
  model: gpt-4o-mini
  memory:
    enabled: true

# 新
plugins:
  - name: ai-chat
    enabled: true          # 插件开关：false = 完全不加载
    options:               # 原来 ai: 下的内容整段搬过来
      enabled: true
      model: gpt-4o-mini
      memory:
        enabled: true
```

不搬也能用：插件配置里没有 `options` 时，会读旧的顶层 `ai:`，启动时打一条提示。两处都写了时以插件配置为准。

## 迁移做了什么

数据库结构由版本化迁移管理（`schema_migrations` 表记录执行过的版本）。每个版本在**独立的事务**里执行：某个版本失败时整体回滚、不记录，后续版本不再执行，只会关闭 AI 记忆相关功能（日志里有原因），**推文推送照常工作**。修好问题后重启会从失败的版本继续。

| 版本 | 内容 |
|---|---|
| v1 | 基础设施：`kv_meta`（内部元数据）、`jobs`（后台任务队列）、`llm_usage`（模型用量） |
| v2 | 身份与消息：`users`、`guilds`、`guild_members`、`name_history`、`channels`、`messages`（+ 全文索引 `messages_fts` 和同步触发器）、`interaction_edges`、`activity_sessions`、`user_stats`；导入旧的频道消息和对话日志 |
| v3 | 记忆：`memories`（+ 全文索引 `memories_fts`）、`profiles`；导入旧的键值记忆；旧表改名保留 |
| v4 | 好感与情绪：`relationships`、`affinity_events`、`mood_state`、`mood_events` |
| v5 | 向量：`vectors`（二值索引 `vec_bin_<维度>` 由程序按需建立） |
| v6 | 删除墓碑：`forgotten_users`（只存加盐哈希） |
| v7 | 消息墓碑：`forgotten_messages`（`/forget-me` 时连带删除的 bot 消息 ID，阻止历史回望把它们导回来） |
| v8 | 旧记忆的隐私处理：导入的旧记忆里含禁止保存信息（手机号、证件号……）的删除，涉及敏感话题或性别 / 感情状况的标为敏感；涉及的人的画像和未置顶反思特点失效、之后重新生成 |
| v9 | `messages.reply_to_author_id`：bot 的消息记下它回复的是谁（原消息被删掉后 `/forget-me` 仍能找到 bot 对本人说过的话） |
| v10 | `memories.participants`：服务器记忆、窗口摘要是从哪些成员的发言来的（原消息被删掉 / 过了保留期，`/forget-me` 仍能认出来） |

### 旧数据怎么转换

| 旧表 | 转换成 | 细节 |
|---|---|---|
| `ai_memories`（按用户名的键值记忆） | `memories` | 作为"关于某人的事实"导入；`preferred_name`、`pronouns`（旧 `/pronouns` 设置的代词）、`location`、`birthday` 等白名单内的键变成 slot（单值属性），并从"希望被称呼为「翅膀」"这类句子里取出简短的值；重要度 = 旧 weight × 10；来源标记为 `legacy` |
| `ai_conversations`（一对一对话日志） | `messages` | 每个用户一个虚拟频道 `legacy-dm:<用户名>`；用户的话记为该用户、bot 的话记为 AI 回复 |
| `channel_messages`（频道消息日志，只有显示名） | `messages` | 作者 ID 暂时为空；服务器 ID 在运行时按频道补上；历史回望重新拉到同一条消息时补全作者 |
| 以上三张表本身 | 改名为 `_legacy_ai_memories`、`_legacy_ai_conversations`、`_legacy_channel_messages` | 原样保留作备份；`/forget-me` 和保留期清理也会处理其中的原话 |

### 旧身份怎么绑定到用户 ID

旧数据只记了用户名，迁移时先以 `legacy:<用户名>` 占位，之后自动绑定到真实的用户 ID：

- 启动时在允许的服务器里**按用户名搜索一次成员**，用户名完全相同的立即绑定；
- 之后**第一次看到**同用户名的成员发言时绑定（Discord 新用户名全局唯一）；
- 绑定时如果真实 ID 下已经有同一个 slot 的新值（比如先用了 `/callme`），保留新值，旧值转为历史；
- 日志：`[Ingest] 旧数据身份绑定: alice → 1234…（N 行）`。

一直没出现过的旧用户名会一直保持占位状态，不影响其他功能。

## 配置变化

### 废弃的字段

这些 `memory.*` 字段已经不再生效（加载配置时日志会提示一次），可以删掉：

| 废弃字段 | 对应的新配置 |
|---|---|
| `maxProfileItems` | `memory.core.userPins`（每人置顶条数） |
| `maxProfileChars` | `memory.context.speakerChars`（说话人档案字数） |
| `recentTurns` | `memory.context.recentChannelMessages`（频道最近消息条数） |
| `recallLimit` | 由模型调用 `search_memory` 时自己指定 |
| `logConversations` | `memory.observe.enabled`（所有消息统一入库） |
| `maxConversationsPerUser` | `memory.observe.retentionDays`（原始消息保留天数） |

### 新增的配置段

`persona`、`lore`、`history`、`memory.observe` / `extractor` / `core` / `context` / `tools`、`embedding`、`vector`、`affinity`、`mood`、`proactive`，以及 `discord.privilegedIntents`。全部有默认值，示例配置（`config.example.yaml` / `.json` / `.toml`，三份内容一致）里每个字段都有注释。`maxToolIterations` 的默认值从 8 改为 12。

### 行为变化

| 以前 | 现在 |
|---|---|
| 只记和 bot 聊天的人、聊天时的内容 | 被动观察所有成员在所有可见频道的消息（`observe.enabled: false` 可关闭） |
| `systemPrompt` 是全部人格 | 人格来自人设卡。首次生成默认卡时，你自定义过的 `systemPrompt` 会并入卡里的 `extraInstructions`；之后 `systemPrompt` 只在一张人设卡都没有时才使用 |
| `@everyone` 也会触发回复 | 不再触发 |
| 回复可能提醒任意被提到的人 | 只提醒本轮出现过的人；`@everyone` / 角色一律不提醒 |

## 命令变化

| 以前 | 现在 |
|---|---|
| `/memory` | 保留，内容变成完整的记忆档案（带编号） |
| `/delete-memory key:` | 改为 `/forget id:`（编号见 `/memory`） |
| `/pronouns pronouns:` | 保留，参数改名为 `代词:`；数据存进记忆系统（只有本人能设置），填"清除"可清除 |
| — | 新增 `/callme`、`/affinity`、`/optout`、`/optin`、`/forget-me`、`/shh` |

斜杠命令在启动时整批注册，旧命令会自动消失。

## 回滚

迁移是**单向的**（不会把新表转换回旧格式）。需要回到旧版本时：

1. 停掉 bot；
2. **用升级前的备份**恢复 `data/bot.db`（以及 `-wal`、`-shm`）——这是最简单、最可靠的办法；
3. 换回旧代码，启动。

没有备份时：新版本把旧表改名保留了，可以手动改回来（旧代码只认原来的表名）：

```bash
sqlite3 data/bot.db "ALTER TABLE _legacy_ai_memories RENAME TO ai_memories;
                     ALTER TABLE _legacy_ai_conversations RENAME TO ai_conversations;
                     ALTER TABLE _legacy_channel_messages RENAME TO channel_messages;"
```

升级后新产生的数据（新记忆、好感、新消息）旧版本用不上。之后如果再升级回新版本，程序发现 v1–v10 已经执行过，不会重复导入；而改回原名的旧表不会再被导入，新版本里已有的数据保持不变。

如果把迁移到 v10 的数据库交给只认识到 v9 的程序（回滚到了某个中间版本），日志会提示"数据库结构版本 v10 高于当前程序已知的 v9，可能是回滚了代码"；程序不会尝试降级，按它认识的部分继续运行。
