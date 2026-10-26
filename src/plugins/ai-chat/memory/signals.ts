import { logger } from '@/logger';
/**
 * 窗口抽取顺带产出的两类信号：群里背后谈论 bot 的态度（旁听好感）、整段聊天的气氛（影响情绪）。
 * 由好感/情绪模块消费；这里定义数据形状和分发入口。
 */

export type BotSentiment = { userId: string; delta: number; reason: string; messageId: string | null };

export type Atmosphere = { tone: string; valence: number; arousal: number };

export type SignalContext = { guildId: string; channelId: string; at: number };

type SentimentSink = (entries: BotSentiment[], ctx: SignalContext) => void;
type AtmosphereSink = (atm: Atmosphere, ctx: SignalContext) => void;

let sentimentSink: SentimentSink | null = null;
let atmosphereSink: AtmosphereSink | null = null;

export function onBotSentiment(fn: SentimentSink | null): void {
  sentimentSink = fn;
}

export function onAtmosphere(fn: AtmosphereSink | null): void {
  atmosphereSink = fn;
}

export function emitBotSentiment(entries: BotSentiment[], ctx: SignalContext): void {
  if (entries.length === 0 || !sentimentSink) return;
  try {
    sentimentSink(entries, ctx);
  } catch (e) {
    logger.warn('Extract', '处理旁听好感失败(忽略):', (e as Error).message);
  }
}

export function emitAtmosphere(atm: Atmosphere, ctx: SignalContext): void {
  if (!atmosphereSink) return;
  try {
    atmosphereSink(atm, ctx);
  } catch (e) {
    logger.warn('Extract', '处理群聊气氛失败(忽略):', (e as Error).message);
  }
}
