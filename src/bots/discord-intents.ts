import { GatewayIntentBits } from 'discord.js';
import type { PrivilegedIntentMode } from '@/types';

export type PrivilegedIntents = { members: boolean; presences: boolean };

export type IntentDecision = PrivilegedIntents & {
  /** 应用标志位的读取结果；null = 没读（都不是 auto）或读取失败 */
  flags: number | null;
};

// Discord 应用标志位：*_LIMITED 是不足 100 个服务器、在开发者后台 Bot 页面打开开关后得到的版本
const FLAG_PRESENCE = 1 << 12;
const FLAG_PRESENCE_LIMITED = 1 << 13;
const FLAG_GUILD_MEMBERS = 1 << 14;
const FLAG_GUILD_MEMBERS_LIMITED = 1 << 15;

export function privilegedFromFlags(flags: number): PrivilegedIntents {
  return {
    presences: (flags & (FLAG_PRESENCE | FLAG_PRESENCE_LIMITED)) !== 0,
    members: (flags & (FLAG_GUILD_MEMBERS | FLAG_GUILD_MEMBERS_LIMITED)) !== 0,
  };
}

/** 读取当前应用的标志位（GET /applications/@me）；失败返回 null */
export async function fetchApplicationFlags(token: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[Intents] 读取应用标志位失败 HTTP ${res.status}，特权 intent 按未开启处理`);
      return null;
    }
    const data = (await res.json()) as { flags?: unknown };
    const flags = Number(data.flags);
    return Number.isFinite(flags) ? flags : null;
  } catch (e) {
    console.warn('[Intents] 读取应用标志位失败，特权 intent 按未开启处理:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 按配置决定要不要订阅两个特权 intent：on/off 直接生效，auto 看应用标志位（读不到就当没开，保证能登录） */
export async function decidePrivilegedIntents(
  token: string,
  modes: { members: PrivilegedIntentMode; presences: PrivilegedIntentMode },
  fetchImpl: typeof fetch = fetch
): Promise<IntentDecision> {
  const needFlags = modes.members === 'auto' || modes.presences === 'auto';
  const flags = needFlags ? await fetchApplicationFlags(token, fetchImpl) : null;
  const fromFlags = flags === null ? { members: false, presences: false } : privilegedFromFlags(flags);
  const pick = (mode: PrivilegedIntentMode, auto: boolean): boolean => (mode === 'on' ? true : mode === 'off' ? false : auto);
  return {
    members: pick(modes.members, fromFlags.members),
    presences: pick(modes.presences, fromFlags.presences),
    flags,
  };
}

export function buildIntents(p: PrivilegedIntents): GatewayIntentBits[] {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ];
  if (p.members) intents.push(GatewayIntentBits.GuildMembers);
  if (p.presences) intents.push(GatewayIntentBits.GuildPresences);
  return intents;
}

/** 登录被拒是因为申请了后台没开的特权 intent（网关关闭码 4014） */
export function isDisallowedIntentsError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const text = `${String(err?.code ?? '')} ${String(err?.message ?? '')}`;
  return /4014|disallowed\s*intents|privileged intent/i.test(text);
}
