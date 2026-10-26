# 运维、隐私与排错

- [成本与体积](#成本与体积)
- [日志](#日志)
- [常用查询](#常用查询)
- [隐私](#隐私)
- [故障与降级](#故障与降级)
- [验收与测试](#验收与测试)

---

## 成本与体积

以下是本机实测加粗略估算，实际取决于消息长度、群的活跃程度和模型。

### 数据库体积

| 项 | 实测 |
|---|---|
| 每条消息（含全文索引） | 0.4–1 KB；10 万条约 40–100 MB |
| 每条记忆 | 约 1 KB；带 1024 维向量约 5 KB（1 万条记忆约 50 MB） |

控制体积：`memory.observe.retentionDays`（原始消息保留天数，提炼出的记忆不受影响）。`/forget-me` 会整理全文索引并截断 WAL。

### 模型用量

| 调用 | 实测输入 / 输出 |
|---|---|
| 一次聊天回复 | 约 5 千 token 输入（人设 + 核心记忆 + 工具定义；模型调用工具时多轮），几百 token 输出 |
| 一次窗口提炼（40 条消息、16 个相关的人） | 输入约 1.5 万字符（约 1 万 token），输出几百 ~ 一千多 token |
| 一次互动评估 | 约 1.5 千 token 输入，几百输出 |
| 一次插话判断 | 约 400 token 输入 |

粗算：每天 2000 条消息的服务器，提炼约 50 次 ≈ 50 万输入 token；加上聊天、评估和判断，后台部分通常每天在 100 万 token 以内。

### 控制花费

| 手段 | 配置 |
|---|---|
| 后台任务用便宜的模型 | `memory.extractor.model` / `apiUrl` / `apiKey`；`proactive.judgeModel` |
| 提炼和画像的每日 token 上限 | `memory.extractor.dailyTokenBudget`（默认 300 万；提炼、画像、互动评估的用量都计入，用完后提炼和画像顺延到第二天；互动评估和聊天不受它限制） |
| 插话判断次数上限 | `proactive.maxJudgeCallsPerDay`（默认 400） |
| 后台请求太频繁被上游限流 | `memory.extractor.minIntervalMs`（后台请求之间的最小间隔，毫秒；默认 0）。被限流时后台任务会自动暂停、推迟，不算失败 |
| 不观察某些频道 | `memory.observe.channelDenylist`（已经入库的消息也不再提炼） |
| 完全不被动观察 | `memory.observe.enabled: false`（只记和它的直接对话） |

所有调用按"日期 × 用途 × 模型"记在 `llm_usage` 表里，见[常用查询](#常用查询)。

---

## 日志

| 前缀 | 内容 |
|---|---|
| `[AI]` | 聊天：请求、工具调用、回复、截断、重试 |
| `[AI:extract]` / `[AI:appraise]` / … | 后台模型调用的重试与错误 |
| `[DB]` | 数据库迁移 |
| `[Intents]` | 特权 intent 检测与降级 |
| `[Ingest]` / `[History]` | 入库、历史回望、旧身份绑定 |
| `[Extract]` | 每次提炼：新增 / 更新 / 取代 / 丢弃了多少条，以及丢弃原因 |
| `[Proactive]` | 每次插话评估的得分、触发信号、判断结果和插话内容 |
| `[Vector]` | 向量后端、回填进度 |
| `[Jobs]` | 后台任务启动、重试、失败 |
| `[Persona]` / `[Lore]` | 人设卡、设定集的加载与报错 |
| `[Forget]` / `[Retention]` | 数据删除与保留期清理 |

---

## 常用查询

```bash
# 模型用量（按天、按用途）
sqlite3 data/bot.db "SELECT day, purpose, model, calls, prompt_tokens, completion_tokens FROM llm_usage ORDER BY day DESC, purpose"

# 后台任务排队情况
sqlite3 data/bot.db "SELECT type, status, COUNT(*) FROM jobs GROUP BY 1, 2"
sqlite3 data/bot.db "SELECT id, type, attempts, last_error FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20"

# 某个人的记忆（把 ID 换成实际的用户 ID）
sqlite3 data/bot.db "SELECT id, kind, slot, content, pinned, sensitive, status FROM memories WHERE scope = 'user' AND subject_id = '123456789012345678' ORDER BY pinned DESC, importance DESC"

# 好感变化的审计记录（最近 20 条）
sqlite3 data/bot.db "SELECT datetime(created_at/1000, 'unixepoch', '+8 hours'), user_id, delta, after, category, reason, source FROM affinity_events ORDER BY id DESC LIMIT 20"

# 今天的主动插话
sqlite3 data/bot.db "SELECT datetime(created_at/1000, 'unixepoch', '+8 hours'), channel_id, content_text FROM messages WHERE proactive = 1 AND created_at > strftime('%s', 'now', 'start of day', '-8 hours') * 1000"

# 各频道的插话偏置（越负越安静）
sqlite3 data/bot.db "SELECT name, proactive_bias, datetime(quiet_until/1000, 'unixepoch', '+8 hours') FROM channels ORDER BY proactive_bias"

# 当前心情
sqlite3 data/bot.db "SELECT valence, arousal, cause, datetime(updated_at/1000, 'unixepoch', '+8 hours') FROM mood_state"
```

所有表的结构都是可读的；`messages`、`memories` 另有全文索引表（`*_fts`），不要直接修改。

---

## 隐私

**这一节不构成法律意见。** 被动观察所有成员的消息、读取在线状态、跨服务器共享记忆是否合规（GDPR、个人信息保护法、Discord 开发者政策等），需要服务器所有者自己确认，并告知成员。

### 默认的保护

- 所有数据都在本机 `data/bot.db`，会发送给你配置的模型服务商（聊天、提炼、评估）和向量服务（如果配置了）。
- **敏感话题**（健康、性取向、宗教、政治、家庭隐私）只接受本人亲口说的，并且只在和本人聊天时使用。判断是否敏感时，模型给出的标记（提炼器和 `remember` / `revise_memory` 都有 `sensitive` 字段）和关键词规则任意一个命中就算，关键词只是兜底；**密码 / 密钥 / token、身份证号、银行卡号、手机号、邮箱、详细住址**永远不会写进记忆（正文和取值字段都检查）。
- 别人的转述以较低的置信度记下并标注"转述"；称呼只能由本人决定。
- 标为敏感的称呼和外号只给本人看；别人能看到的东西——bot 对某人的印象、专属称呼、bot 的自我记忆、心情原因、服务器记忆、窗口摘要——都不会写入敏感话题或禁止保存的信息。
- 模型读原话时**不转述私密频道**：只读当前频道和所有成员都能看的频道（私密频道、私密子区的内容只能在那里面问）。注意这只管原话——从私密频道提炼出来的记忆和其它记忆一样共享；不想让某个频道形成记忆，把它加进 `memory.observe.channelDenylist`。
- 原话默认**不跨服务器**（`observe.crossGuildMessages: false`）：在 A 服务器里聊天时，模型读不到 B 服务器的原始消息（包括通过频道 ID、消息 ID 指定）。
- 在线状态只在内存里保留当前值，写库的只有持续 5 分钟以上的活动。
- 好感数值从不出现在回复里；评估的输入做了[结构隔离](algorithms.md#防提示词注入结构隔离)，防提示词注入。

### 成员可以做什么

| 命令 | 效果 |
|---|---|
| `/memory` | 查看关于自己的全部记忆 |
| `/forget id:` | 删除一条（连同被它取代过的旧版本、对应的向量；相关画像失效） |
| `/optout` | 之后的消息不入库、不形成新记忆、不自动刷新资料、不触发主动插话；模型也不能再写关于 TA 的事。已有数据保留 |
| `/optin` | 恢复 |
| `/forget-me` | 删除全部数据（按钮二次确认；可以私信 bot 使用） |

### forget-me 删除范围

在一个事务里完成，失败不会留下半截：

- **删除**：本人的所有消息（包括升级前的旧数据），以及 bot 对这些消息的回复和冲这些消息说的主动插话；关于本人的全部记忆和关系；画像；好感度和好感记录；情绪记录；统计；在线活动；互动关系；身份与曾用名；排队中的后台任务；
- **删除**：bot 对本人说过的话（包括本人先删掉了原消息的情况）；信息来源是本人、或证据来自本人消息（含 bot 对本人的回复）的服务器记忆、bot 自我记忆——本人参与过的窗口摘要也在其中（共享记忆记着参与者，原消息被删掉或过了保留期也认得出来）；提到本人、或者和本人有关系 / 有互动的人的画像和未置顶的反思特点（之后会重新生成）；别人统计里嵌着本人的部分（下次重算）；
- **匿名化**：别人消息里对本人的 @ 改成"@已删除的用户"（包括升级前的旧消息）；别人的数据里"信息来源是本人"的标记清空；只是提到本人名字的服务器记忆、bot 自我记忆、审计记录和印象里，名字改成"某人"；
- **物理删除**：删除时开启 SQLite 的 `secure_delete`，整理全文索引并截断 WAL；
- **防止回灌**：留下一条只含加盐哈希的删除墓碑，历史回望再拉到删除前的消息也不会导回来；连带删除的 bot 消息按消息 ID 记墓碑；别人删除前写的消息被补拉或编辑时，对本人的 @ 保持匿名化；正在进行中的后台任务和聊天写工具在写入前会发现并放弃这次结果。

**不删除的**：Discord 上已经发出的消息（那是 Discord 的数据）；别人不带 @ 提到本人名字的原话（那是别人的发言）。认领旧数据和匹配名字时只用本人**独有**的名字——和别人重名的名字、自己设的称呼（`/callme`、自称的外号）不算；共享记忆只有信息来源是本人、或证据来自本人消息时才整条删除，名字匹配只做匿名化——避免误删或被人利用来删除别人的数据。

选择"全部删除"后，本人再发消息会被重新记录；选择"全部删除，并且以后不再记录"则只留下一个空的退出标记（只有用户 ID 和退出时间）。

### 保留期

`memory.observe.retentionDays: N`：每天清理 N 天前的原始消息（包括升级前保留的旧消息表）和在线活动记录；历史回望也不再拉取更早的消息。提炼出来的记忆、画像、好感不受影响。

### 成员告示模板

按需修改后发在公告频道：

> 本服务器的 bot（memecat）会记录大家在 bot 可见频道里的发言，用来形成对每个人的长期记忆、好感度和群聊记忆，让它像一个真正的群成员一样记得大家的事。数据保存在管理员自己的机器上，并会发送给我们使用的 AI 模型服务商（＿＿＿）用于生成回复和提炼记忆。
> 你可以随时：用 `/memory` 查看它记得你什么，用 `/forget` 删除某一条，用 `/optout` 让它不再记录你，用 `/forget-me` 删除你的全部数据。有问题请联系 ＿＿＿。

---

## 故障与降级

| 情况 | 表现 |
|---|---|
| 特权 intent 没在开发者后台打开 | 自动不订阅；配置强制开启但被 Discord 拒绝时，去掉特权 intent 重新登录。成员列表 / 在线状态相关功能缺失，其余正常 |
| AI 数据库迁移失败 | 只关闭 AI 记忆相关功能，日志里有原因；推文推送照常 |
| 聊天模型不可用 | 自动重试（超时、429、5xx）；最终失败时回复"AI 暂时不可用" |
| 后台模型不可用 | 任务按退避重试，最多 5 次，之后由调度重新投递；不影响聊天。只有问题出在这批消息本身（内容审核拒绝、输入过长、给不出合格 JSON）时才跳过这个窗口（日志 `[Memory] … 已跳过`）；key 配错、参数不支持、模型不可用、5xx、网络问题不跳过，修好后接着提炼 |
| 被上游限流（429） | 后台任务一起暂停（30 秒起、连续限流翻倍、最长 10 分钟，或按 `Retry-After`），任务推迟、不算失败；聊天照常短暂重试 |
| 后台 token 预算用完 | 提炼、画像顺延到第二天 0 点（UTC+8） |
| 向量服务不可用 / 超时 | 查询 3 秒超时后只用全文检索；回填任务稍后重试 |
| sqlite-vec 加载失败 | 自动改用 JS 后端，结果一致 |
| 人设卡 / 设定集写错 | 保留上一版，日志提示错误位置 |
| 运行中在 WebUI 关掉记忆 | 依赖记忆的后台任务原样留在队列里，重新打开后继续 |
| 进程崩溃 / 重启 | 后台任务在 `jobs` 表里不丢；执行到一半的任务重新排队；历史回望从上次成功的位置继续补缺口 |
| 消息热路径出错 | 入库、插话评估的异常只记日志，不影响回复 |

---

## 验收与测试

```bash
bun run test        # 单元 + 集成测试（内存数据库、假的 LLM / Discord，不连外网）
bun run typecheck   # 类型检查（含测试文件）
```

- `src/bots/acceptance.test.ts`：**离线验收**。走真实的 Discord 消息处理链与斜杠命令分发，Discord 换成假客户端、模型换成按场景编排的假模型，把人工验收清单（人格与 @、记忆、好感、主动插话、隐私命令……）逐项跑一遍。
- `scripts/acceptance-live-llm.ts`：**真实模型验收**。用 `config.yaml` 里配置的聊天模型跑同样的场景并打印对话记录，用来看模型本身的发挥（语气、记不记得事、被骂后的态度、防注入、插话是否自然）。不连 Discord、用内存数据库、不碰 `data/`，大约 30 次模型调用：

  ```bash
  bun scripts/acceptance-live-llm.ts          # 全部场景
  bun scripts/acceptance-live-llm.ts 6 7 8    # 只跑部分场景
  ```

- `scripts/eval-retrieval.ts`：检索评测（全文 / 混合检索的 recall@5、二值粗筛的召回率、两个后端的一致性），需要一个真实的向量服务：

  ```bash
  EMBED_URL=http://127.0.0.1:11434/v1 EMBED_MODEL=bge-m3 bun run scripts/eval-retrieval.ts
  ```

真实 Discord 上的行为（登录与 intent 协商、斜杠命令注册、真实的 @ 提醒、权限与限流）仍需要在测试服务器上人工确认。
