import type { GuildTextBasedChannel, Message, TextChannel } from 'discord.js';
import { getConfig } from '../config';
import { queueAppraisal } from '../ai/appraise';
import { markBotMessage } from '../ai/channels';
import { chatWithAI } from '../ai/chat';
import { personFromDiscord, renderMessage } from '../ai/discord-adapter';
import { channelQuoteGuard, ingestLiveMessage, onStoredMessageReaction } from '../ai/discord-runtime';
import { ingestDelete, withoutForgottenRendered } from '../ai/ingest';
import { isOptedOut, personFromDb } from '../ai/identity';
import { mentionedPeople, sanitizeOutgoingMentions } from '../ai/mentions';
import { personaForGuild } from '../ai/persona/loader';
import {
  channelBias,
  collectTriggers,
  computeScore,
  decayBiases,
  gateReason,
  judge,
  onFollowupMessage,
  onProactiveReaction,
  recordProactiveReaction,
  releaseJudge,
  releaseProactive,
  reserveJudge,
  reserveProactive,
  settleExpired,
  trackProactive,
  type ChannelRef,
} from '../ai/proactive';
import { forgetEpoch, forgottenBefore, recordForgottenMessage } from '../ai/forget-guard';
import type { PersonaCard } from '../ai/persona/card';
import { resolveReactions } from '../ai/reactions';
import { registerScheduler } from '../ai/worker';
import { sendAiText, startTyping } from './discord-send';

type ChannelTimer = { timer: ReturnType<typeof setTimeout> | null; count: number; latest: Message; selfId: string };

const timers = new Map<string, ChannelTimer>();
const evaluating = new Set<string>();
// 频道里正在生成的直接回复（被 @ / 被回复）：这期间不评估、不发主动插话
const directReplies = new Map<string, number>();

/** 开始直接回复：取消这个频道排着的插话评估 */
export function beginDirectReply(channelId: string): void {
  directReplies.set(channelId, (directReplies.get(channelId) ?? 0) + 1);
  const state = timers.get(channelId);
  if (state?.timer) clearTimeout(state.timer);
  timers.delete(channelId);
}

export function endDirectReply(channelId: string): void {
  const n = (directReplies.get(channelId) ?? 1) - 1;
  if (n > 0) directReplies.set(channelId, n);
  else directReplies.delete(channelId);
}

const replyingIn = (channelId: string): boolean => (directReplies.get(channelId) ?? 0) > 0;
const inflight = new Set<Promise<void>>();

function runEvaluation(latest: Message, selfId: string): void {
  const p: Promise<void> = evaluate(latest, selfId).finally(() => inflight.delete(p));
  inflight.add(p);
}

function refOf(message: Message): ChannelRef {
  const ch = message.channel as GuildTextBasedChannel & { parentId?: string | null };
  return { channelId: message.channelId, guildId: message.guildId ?? '', parentId: ch.parentId ?? null };
}

function enabled(): boolean {
  const ai = getConfig().ai;
  return ai.enabled && ai.proactive.enabled;
}

/** 有人直接叫了 bot：如果 bot 刚主动插过话，算作被接住 */
export function onAddressedMessage(message: Message): void {
  if (!enabled() || !message.guildId) return;
  onFollowupMessage(
    { channelId: message.channelId, replyToId: message.reference?.messageId ?? null, text: message.content ?? '', addressedToBot: true },
    personaForGuild(message.guildId),
    Date.now()
  );
}

/** 不是在叫 bot 的消息：记录插话反馈；然后防抖，频道安静一会儿（或刷屏到一定条数）后评估要不要插话 */
export function onUnaddressedMessage(message: Message, selfId: string): void {
  // 退出记录的人：消息不入库，也不该触发插话
  if (!enabled() || !message.guildId || isOptedOut(message.author.id)) return;
  try {
    onFollowupMessage(
      { channelId: message.channelId, replyToId: message.reference?.messageId ?? null, text: message.content ?? '', addressedToBot: false },
      personaForGuild(message.guildId),
      Date.now()
    );
  } catch (e) {
    console.warn('[Proactive] 记录反馈失败(忽略):', (e as Error).message);
  }
  const cfg = getConfig().ai.proactive;
  const state = timers.get(message.channelId) ?? { timer: null, count: 0, latest: message, selfId };
  state.latest = message;
  state.count++;
  if (state.timer) clearTimeout(state.timer);
  const fire = (): void => {
    // 触发后就释放：不长期持有完整的 Message（论坛帖子、临时子区很多时状态会越积越多）
    if (timers.get(message.channelId) === state) timers.delete(message.channelId);
    state.timer = null;
    runEvaluation(state.latest, state.selfId);
  };
  timers.set(message.channelId, state);
  if (state.count >= cfg.forceEvalEveryMessages) fire();
  else state.timer = setTimeout(fire, cfg.debounceSeconds * 1000);
}

function scheduleRecheck(message: Message, selfId: string, at: number): void {
  const state = timers.get(message.channelId);
  if (state?.timer) return; // 已经有一次评估在排队
  const delay = Math.max(1000, at - Date.now() + 500);
  const s: ChannelTimer = state ?? { timer: null, count: 0, latest: message, selfId };
  s.timer = setTimeout(() => {
    if (timers.get(message.channelId) === s) timers.delete(message.channelId);
    s.timer = null;
    runEvaluation(s.latest, s.selfId);
  }, delay);
  timers.set(message.channelId, s);
}

async function evaluate(latest: Message, selfId: string): Promise<void> {
  const ref = refOf(latest);
  if (evaluating.has(ref.channelId)) return;
  evaluating.add(ref.channelId);
  try {
    const persona = personaForGuild(ref.guildId);
    if (!persona) return;
    const now = Date.now();
    if (replyingIn(ref.channelId)) return;
    // 先用最宽松的条件（按"被叫名字"的短冷却）过一遍零成本闸门：静默、上限、频道限制等直接挡住，
    // 不再去扫描信号（记忆信号可能要请求向量服务）
    if (gateReason(ref, persona, now, true)) return;
    const scan = await collectTriggers(ref, persona, now);
    if (scan.recheckAt) scheduleRecheck(latest, selfId, scan.recheckAt);
    if (scan.triggers.length === 0) return;
    const aliasCalled = scan.triggers.some((t) => t.kind === 'alias');
    const blocked = gateReason(ref, persona, now, aliasCalled);
    if (blocked) return;
    const score = computeScore(scan.triggers, persona, scan.recent, channelBias(ref.channelId), now);
    if (score < getConfig().ai.proactive.threshold) return;

    // 预占一次判断名额：几个频道同时评估时不会一起突破每日判断上限
    if (!reserveJudge(now)) return;
    let decision: Awaited<ReturnType<typeof judge>>;
    try {
      decision = await judge(persona, scan, now);
    } finally {
      releaseJudge();
    }
    console.log(
      `[Proactive] #${(latest.channel as TextChannel).name ?? ref.channelId} 得分 ${score.toFixed(2)}（${scan.triggers.map((t) => t.kind).join('+')}）→ ${decision.action}${decision.reason ? `：${decision.reason}` : ''}`
    );
    if (decision.action === 'none' || !decision.target) return;

    const target = await latest.channel.messages.fetch(decision.target.message_id).catch(() => null);
    if (!target || !targetAllowed(target)) return;
    // 判断模型返回期间可能有人 /shh、bot 刚回复过别人、或者有人直接 @ 了 bot：发之前再过一遍闸门
    if (replyingIn(ref.channelId) || gateReason(ref, persona, Date.now(), aliasCalled, { recheck: true })) return;
    if (decision.action === 'react') {
      // 只贴表情也是一次主动参与：同样预占名额、计入每小时 / 每天的上限
      const [emoji] = resolveReactions([decision.emoji]);
      if (!emoji || !reserveProactive(ref, Date.now())) return;
      try {
        const ok = await target.react(emoji).then(
          () => true,
          (e) => {
            console.warn('[Proactive] 贴表情失败:', (e as Error).message);
            return false;
          }
        );
        if (ok) recordProactiveReaction(ref, Date.now());
      } finally {
        releaseProactive(ref);
      }
      return;
    }
    // 预占一次名额：几个频道同时通过检查时不会一起突破每小时 / 每天的上限
    if (!reserveProactive(ref, Date.now())) return;
    try {
      await speak(target, selfId, ref, persona, decision.reason, aliasCalled);
    } finally {
      releaseProactive(ref);
    }
  } catch (e) {
    console.warn('[Proactive] 评估失败(忽略):', (e as Error).message);
  } finally {
    evaluating.delete(ref.channelId);
  }
}

/** 插话对象必须仍可记录：没有 /optout，也不是 TA /forget-me 之前的消息 */
function targetAllowed(target: Message): boolean {
  return !isOptedOut(target.author.id) && !forgottenBefore(target.author.id, target.createdTimestamp);
}

/** 生成并发出一句主动插话（走正常的聊天流程，带人设与记忆） */
async function speak(target: Message, selfId: string, ref: ChannelRef, persona: PersonaCard, reason: string, asReply: boolean): Promise<void> {
  // 目标可能是别人删除数据之前写的：和入库一样匿名化其中对已删除的人的 @
  const rendered = withoutForgottenRendered(renderMessage(target, selfId, true), target.createdTimestamp);
  const people = mentionedPeople(rendered).filter((p) => !p.isSelf && p.id !== target.author.id);
  const stopTyping = target.channel.isTextBased() ? startTyping(target.channel as TextChannel) : () => {};
  let reply = '';
  let reactions: string[] = [];
  const epoch = forgetEpoch();
  try {
    const res = await chatWithAI(rendered.text, {
      username: target.author.username,
      userId: target.author.id,
      displayName: target.member?.displayName || target.author.username,
      speaker: personFromDiscord(target.author, target.member, selfId),
      people,
      platform: 'discord',
      guildId: ref.guildId,
      channelId: ref.channelId,
      messageId: target.id,
      proactive: { reason },
      canQuoteChannel: channelQuoteGuard(target.client, target.author.id),
    });
    reply = res.reply;
    reactions = res.reactions;
  } finally {
    stopTyping();
  }
  if (!reply.trim()) return;
  // 生成期间（可能好几秒）有人 /shh、对方退出记录或删除了数据：不发
  if (!targetAllowed(target) || replyingIn(ref.channelId) || gateReason(ref, persona, Date.now(), asReply, { recheck: true })) return;
  for (const emoji of reactions.slice(0, 1)) await target.react(emoji).catch(() => undefined);
  // 生成和贴表情期间有人删除了数据（可能正是上下文里的某个人）：插话本来就可有可无，直接放弃
  if (forgetEpoch() !== epoch) return;
  // 主动插话一律不提醒任何人：@ 都改成纯文本的名字
  const { text } = sanitizeOutgoingMentions(reply, new Set(), (id) => personFromDb(id, ref.guildId, selfId)?.displayName ?? null);
  const sent = await sendAiText(target, text, [], asReply);
  const now = Date.now();
  if (sent.length === 0) return;
  markBotMessage(ref.channelId, now);
  if (forgetEpoch() !== epoch) {
    // 发送期间有人删除了数据：发出的插话不入库、不登记反馈；记消息墓碑，并删掉 Discord 回传后可能先入库的同一条
    for (const m of sent) {
      recordForgottenMessage(m.id, now);
      ingestDelete(m.id);
    }
    return;
  }
  // 直接发到频道的插话没有"回复"引用：入库时记下它是冲哪条消息说的（/forget-me 靠它连带删除）
  for (const m of sent) ingestLiveMessage(m, selfId, { kind: 'bot_ai', proactive: true, replyToId: target.id, replyToAuthorId: target.author.id });
  trackProactive(sent[0].id, ref, now);
  queueAppraisal({
    userId: target.author.id,
    guildId: ref.guildId,
    channelId: ref.channelId,
    userMessageId: target.id,
    botMessageIds: sent.map((m) => m.id),
    personaId: personaForGuild(ref.guildId)?.id ?? null,
    proactive: true,
  });
  console.log(`[Proactive] 插话：${text.slice(0, 60).replace(/\s+/g, ' ')}`);
}

let registered = false;

/** 注册插话反馈：表情反应、定期结算没人理的插话、频道偏置每日回归 */
export function registerProactive(): void {
  if (registered) return;
  registered = true;
  onStoredMessageReaction((reacted, messageId) => {
    if (reacted.proactive) onProactiveReaction(messageId, (guildId) => personaForGuild(guildId));
  });
  registerScheduler('proactive-feedback', 60_000, (now) => {
    settleExpired((guildId) => personaForGuild(guildId), now);
    decayBiases(now);
  });
}

/** 测试用：等待正在进行的评估全部结束 */
export async function settleProactiveForTesting(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/** 测试用：清掉所有防抖计时器与状态 */
export function resetDiscordProactiveForTesting(): void {
  for (const s of timers.values()) if (s.timer) clearTimeout(s.timer);
  timers.clear();
  evaluating.clear();
  directReplies.clear();
}
