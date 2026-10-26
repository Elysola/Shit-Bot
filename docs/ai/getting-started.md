# 使用教程

分两部分：[管理员：部署与调整](#管理员部署与调整)、[成员：日常使用](#成员日常使用)。

---

## 管理员：部署与调整

### 1. 准备

- [Bun](https://bun.sh) ≥ 1.3（SQLite 用的是 Bun 内置的 `bun:sqlite`，不需要 C++ 编译工具链）。
- 一个 OpenAI 兼容的聊天接口（OpenAI、各类网关、本地推理服务都可以），以及它的 API key。
- 一个 Discord 应用（bot）。建议**先用一个单独的测试服务器**，确认效果后再加到正式服务器。

### 2. Discord 开发者后台

在 <https://discord.com/developers/applications> → 你的应用 → **Bot**：

| 开关 | 是否必需 | 打开后多了什么 |
|---|---|---|
| Message Content Intent | **必需** | 能读到消息正文 |
| Server Members Intent | 可选 | 成员列表（昵称、角色、入群时间）、成员进出与改名事件 |
| Presence Intent | 可选 | 在线状态、正在玩什么 / 听什么 |

两个可选开关不需要在配置里对应修改：bot 启动时会读取应用的开关状态，开了什么就订阅什么（`discord.privilegedIntents: auto`）。如果开关和实际不符导致 Discord 拒绝登录，bot 会去掉特权 intent 重新登录，不会因此上不了线。

邀请 bot 时给这些权限：**查看频道、读取消息历史**（历史回望需要）、**发送消息、添加反应、嵌入链接、使用应用命令**。

### 3. 最小配置

```bash
bun install
cp config.example.yaml config.yaml
```

只用 AI、不做推文推送时，最少需要这些（其余保持示例里的默认值即可）：

```yaml
twitter:
  enabled: false            # 不做推文监控；否则必须配置 groups
telegram:
  enabled: false
discord:
  enabled: true
  token: YOUR_DISCORD_BOT_TOKEN
ai:
  enabled: true
  apiUrl: https://api.openai.com/v1   # 任何 OpenAI 兼容接口
  apiKey: sk-...                      # 也可以用环境变量 AI_API_KEY
  model: gpt-4o-mini
  maxTokens: 4096                     # 带"思考"的模型请给大一些，否则长回复会被截断
  allowedGuildIds: ["你的服务器ID"]    # 空 = 所有服务器
  memory:
    enabled: true
```

> WebUI 目前没有 AI 设置界面，AI 相关配置请直接改配置文件（WebUI 保存其它设置时会原样保留它们）。配置文件是 TOML 时只能读取、不能从 WebUI 保存。

### 4. 启动

```bash
bun run dev                 # 开发：直接运行 TypeScript
# 或
bun run build && bun run start
```

首次启动会发生这些事（看日志就能确认）：

1. **数据库迁移**：`[DB] AI 数据结构已迁移到 v5`。从旧版本升级时会自动导入旧数据，见[升级与数据迁移](upgrade-and-migration.md)。
2. **生成默认人设卡**：`data/personas/` 为空时写出 `memecat.yaml`，之后改这个文件就能调整人格，保存即生效。
3. **特权 intent 检测**：`Discord bot 已连接 …；特权 intent：成员事件=开/关，在线状态=开/关`。
4. **历史回望**：每个可见频道回溯最近 30 天、最多 5000 条消息（`[Ingest]` 日志）。频道多、消息多时会持续一段时间，请求之间有 350ms 间隔，不会触发 Discord 限流。
5. **后台任务**：`[Jobs] 后台任务已启动`。之后提炼、画像、互动评估、向量化都在后台慢慢跑。

### 5. 确认它在工作

- 在频道里 @ 它说句话，应该用 memecat 的口吻回复。
- 输入 `/memory`，能看到"关于你的记忆"（刚开始可能是空的）。
- 不 @ 它、正常聊几句个人信息（比如"我下周三面试"）。**只有几句话时，最晚 30 分钟后**会被提炼成记忆；聊够 8 条以上并安静 3 分钟会更快。之后 `/memory` 里就能看到。
- 日志里的 `[Extract]` 行会显示每次提炼新增 / 更新 / 丢弃了多少条。

### 6. 常见调整

| 想要 | 怎么做 |
|---|---|
| 省钱：后台任务用便宜的模型 | `ai.memory.extractor.model` / `apiUrl` / `apiKey`（提炼、画像、互动评估都用它）；`ai.proactive.judgeModel`（插话判断）。不填就沿用聊天模型 |
| 限制后台提炼的花费 | `ai.memory.extractor.dailyTokenBudget`（默认 300 万 token）：提炼和画像每天用到这么多就顺延到第二天；互动评估和聊天的用量计入但不受它限制 |
| 某些频道不观察、不记录 | `ai.memory.observe.channelDenylist`（频道或分类 ID） |
| 只让它在某些频道插话 | `ai.proactive.channels`（白名单）/ `ai.proactive.denyChannels` |
| 让它话多 / 话少 | 人设卡 `proactive.chattiness`（0–1）；或 `ai.proactive.threshold`（越大越少插话） |
| 晚上别插话 | `ai.proactive.quietHours: "01:00-08:00"`（UTC+8）；不填时按人设卡作息，精力低于 0.2 的时段不插话 |
| 关掉主动插话 / 好感 / 情绪 | `ai.proactive.enabled` / `ai.affinity.enabled` / `ai.mood.enabled` 设为 `false` |
| 只回复、不被动观察 | `ai.memory.observe.enabled: false`：只记录叫到它的消息和它的回复，记忆只从这些对话里提炼；不做历史回望，主动插话也基本不会触发（它看不到群聊）。注意：同时开着频道总结（`ai.summary.enabled`）时，为了能总结，所有消息仍会入库，但不会被提炼 |
| 原始消息只保留一段时间 | `ai.memory.observe.retentionDays: 90`（提炼出的记忆不受影响） |
| 不同服务器用不同人格 | 在 `data/personas/` 再放一张卡，然后 `ai.persona.guilds: { "服务器ID": "卡的 id" }` |
| 语义检索 | 配置向量模型，见下一节 |

### 7. 开启向量检索（可选）

不配也能用（只用全文检索）。配了以后，"他家的宠物"能找到"养了一只橘猫叫大黄"这种字面上不重合的记忆。

**本机 Ollama + bge-m3**（中文效果好，1024 维，CPU 也能跑）：

```bash
docker run -d --name ollama -p 127.0.0.1:11434:11434 -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull bge-m3
```

```yaml
ai:
  embedding:
    apiUrl: http://127.0.0.1:11434/v1
    model: bge-m3
```

重启后日志会显示 `[Vector] 后端：sqlite-vec（数据库内计算）` 或 `后端：JS`，并开始在后台给已有记忆补向量。

- CPU 上建议给模型设置 `num_thread`（例如 4）：线程数过多时 Ollama 会忙等，单次查询从 0.2 秒变成好几秒。
- 也可以用任何 OpenAI 兼容的 `/embeddings` 云服务，填 `apiUrl` / `apiKey` / `model` 即可。
- 换模型或维度时会自动清空重算；去掉配置后自动退回全文检索。

### 8. Docker 部署注意

- `data/` 目录必须持久化（数据库、人设卡、设定集都在里面）。配置文件可以放在 `data/config.yaml`。
- 容器里的配置文件是只读挂载时，从 WebUI 保存会自动退回写到 `data/`。
- `bun run build:binary` 编出的单文件程序里加载不了 sqlite-vec 扩展，向量检索会自动用 JS 实现，结果一样，只是慢一些。

---

## 成员：日常使用

### 和它说话

| 方式 | 效果 |
|---|---|
| @ 它，或回复它的消息 | 一定会回复 |
| 不 @、在消息里叫它的名字（"memecat 你说呢"） | 频道安静一会儿后，它多半会以回复的形式接话（不保证） |
| 正常聊天 | 它在旁边看着、记着；偶尔遇到它感兴趣或能帮上忙的话题会自己插一句 |
| `@everyone` / `@here` | 不算叫它 |

它会自然地用上记得的事（"下周三面试准备得怎么样了"），不会念出"我记得你说过……"。

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/memory` | 查看它关于你的全部记忆（只有你能看到；多的时候发 `.md` 附件），每条带编号 |
| `/forget id:` | 删除一条关于你的记忆（编号见 `/memory`） |
| `/callme 称呼:` | 设定你希望被怎么称呼（留空 = 清除） |
| `/affinity` | 看看它现在对你是什么感觉（档位和印象，不显示数值） |
| `/optout` | 不再记录你的消息、不再形成关于你的记忆（@ 它时仍会回复） |
| `/optin` | 恢复记录 |
| `/forget-me` | 删除关于你的全部数据（按钮二次确认，可以私信 bot 使用；可选删除后继续不记录） |
| `/shh 分钟: 范围:` | **需要"管理消息"权限**：让它暂时不要主动插话（默认本频道 60 分钟；0 = 立即恢复；被 @ 照常回复） |

`/forget-me` 具体删什么、不删什么，见[运维、隐私与排错](operations.md#forget-me-删除范围)。
