export type AffinityLevel = 'hostile' | 'cold' | 'neutral' | 'friendly' | 'close' | 'devoted';
export const AFFINITY_LEVELS: readonly AffinityLevel[] = ['hostile', 'cold', 'neutral', 'friendly', 'close', 'devoted'];

export type MoodLabel = '兴奋' | '开心' | '平静' | '无聊' | '困' | '烦躁' | '低落';
export const MOOD_LABELS: readonly MoodLabel[] = ['兴奋', '开心', '平静', '无聊', '困', '烦躁', '低落'];

export type PersonaCard = {
  id: string;
  name: string;
  aliases: string[];
  version: number;
  summary: string;
  identity: string;
  appearance: string;
  backstory: string;
  personality: { core: string[]; quirks: string[] };
  speech: { style: string; catchphrases: string[]; avoid: string[] };
  likes: string[];
  dislikes: string[];
  values: string[];
  /** 最高优先级的底线 */
  boundaries: string[];
  affinityStances: Record<AffinityLevel, string>;
  /** 给好感评估器看的：什么让 TA 好感上升/下降 */
  appraisal: string;
  /** 给抽取器看的：这个角色特别在意什么 */
  memoryFocus: string;
  mood: {
    baseline: { valence: number; arousal: number };
    /** 24 个整点（UTC+8）的精力值 0–1 */
    rhythm: number[];
    styles: Partial<Record<MoodLabel, string>>;
  };
  proactive: { chattiness: number; interests: string[]; style: string };
  examples: Array<{ user: string; reply: string }>;
  /** 自动生成人设卡时并入的旧 systemPrompt 等补充设定 */
  extraInstructions: string;
};

export type ParseResult = { ok: true; card: PersonaCard; warnings: string[] } | { ok: false; error: string };

const DEFAULT_STANCES: Record<AffinityLevel, string> = {
  hostile: '冷淡、带刺、不想多聊，但不撒谎，正常问题照样答对。',
  cold: '客气但疏远，话少。',
  neutral: '默认态度：友好，但还不太了解对方。',
  friendly: '放松、会开玩笑。',
  close: '主动关心对方，记得对方的事并自然地提起。',
  devoted: '很护着对方，有专属的说话方式。',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function num(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
}

/**
 * 24 小时精力曲线：接受 {"00": 0.7, "06": 0.2, ...}（未列出的整点按相邻两点环形线性插值）
 * 或长度 24 的数组；都没有时返回平直曲线 baseline。
 */
export function parseRhythm(v: unknown, baseline: number, warnings: string[]): number[] {
  if (Array.isArray(v)) {
    if (v.length === 24 && v.every((x) => Number.isFinite(Number(x)))) return v.map((x) => clamp(Number(x), 0, 1));
    warnings.push('mood.rhythm 数组必须正好 24 个数字，已改用平直曲线');
    return Array(24).fill(baseline);
  }
  if (!isRecord(v)) return Array(24).fill(baseline);
  const points: Array<[number, number]> = [];
  for (const [k, val] of Object.entries(v)) {
    const h = Number(k);
    const n = Number(val);
    if (Number.isInteger(h) && h >= 0 && h < 24 && Number.isFinite(n)) points.push([h, clamp(n, 0, 1)]);
    else warnings.push(`mood.rhythm 里的 "${k}: ${String(val)}" 无效，已忽略`);
  }
  if (points.length === 0) return Array(24).fill(baseline);
  points.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    // 找到 h 前后最近的两个控制点（环形）
    let prev = points[points.length - 1];
    let next = points[0];
    for (const p of points) {
      if (p[0] <= h) prev = p;
    }
    for (const p of points) {
      if (p[0] >= h) {
        next = p;
        break;
      }
    }
    if (next[0] < h) next = points[0];
    const span = (next[0] - prev[0] + 24) % 24;
    if (span === 0) {
      out.push(prev[1]);
      continue;
    }
    const t = ((h - prev[0] + 24) % 24) / span;
    out.push(Math.round((prev[1] + (next[1] - prev[1]) * t) * 1000) / 1000);
  }
  return out;
}

/** 校验并补全一张人设卡。只有 name 是必填的；其余字段缺失或非法时用默认值并给出警告。 */
export function parsePersonaCard(raw: unknown, fallbackId: string): ParseResult {
  if (!isRecord(raw)) return { ok: false, error: '人设卡不是一个对象（YAML/JSON 顶层应为键值对）' };
  const warnings: string[] = [];
  const name = text(raw.name);
  if (!name) return { ok: false, error: '缺少 name' };

  const id = text(raw.id) || fallbackId;
  if (!/^[\w-]{1,64}$/.test(id)) return { ok: false, error: `id "${id}" 只能包含字母、数字、下划线和短横线` };

  const personality = isRecord(raw.personality) ? raw.personality : {};
  const speech = isRecord(raw.speech) ? raw.speech : {};
  const stancesRaw = isRecord(raw.affinityStances) ? raw.affinityStances : {};
  const affinityStances = {} as Record<AffinityLevel, string>;
  for (const lvl of AFFINITY_LEVELS) {
    affinityStances[lvl] = text(stancesRaw[lvl]) || DEFAULT_STANCES[lvl];
  }

  const moodRaw = isRecord(raw.mood) ? raw.mood : {};
  const baselineRaw = isRecord(moodRaw.baseline) ? moodRaw.baseline : {};
  const baseline = {
    valence: num(baselineRaw.valence, 0.1, -1, 1),
    arousal: num(baselineRaw.arousal, 0.5, 0, 1),
  };
  const stylesRaw = isRecord(moodRaw.styles) ? moodRaw.styles : {};
  const styles: Partial<Record<MoodLabel, string>> = {};
  for (const [k, v] of Object.entries(stylesRaw)) {
    if ((MOOD_LABELS as readonly string[]).includes(k) && text(v)) styles[k as MoodLabel] = text(v);
    else warnings.push(`mood.styles 里的 "${k}" 不是已知心情（${MOOD_LABELS.join('/')}），已忽略`);
  }

  const proactiveRaw = isRecord(raw.proactive) ? raw.proactive : {};
  const examples = Array.isArray(raw.examples)
    ? raw.examples
        .filter(isRecord)
        .map((e) => ({ user: text(e.user), reply: text(e.reply) }))
        .filter((e) => e.user && e.reply)
    : [];

  const aliases = list(raw.aliases);
  if (!aliases.includes(name)) aliases.unshift(name);

  return {
    ok: true,
    warnings,
    card: {
      id,
      name,
      aliases,
      version: num(raw.version, 1, 0, 1e9),
      summary: text(raw.summary),
      identity: text(raw.identity),
      appearance: text(raw.appearance),
      backstory: text(raw.backstory),
      personality: { core: list(personality.core), quirks: list(personality.quirks) },
      speech: { style: text(speech.style), catchphrases: list(speech.catchphrases), avoid: list(speech.avoid) },
      likes: list(raw.likes),
      dislikes: list(raw.dislikes),
      values: list(raw.values),
      boundaries: list(raw.boundaries),
      affinityStances,
      appraisal: text(raw.appraisal),
      memoryFocus: text(raw.memoryFocus),
      mood: { baseline, rhythm: parseRhythm(moodRaw.rhythm, baseline.arousal, warnings), styles },
      proactive: {
        chattiness: num(proactiveRaw.chattiness, 0.35, 0, 1),
        interests: list(proactiveRaw.interests),
        style: text(proactiveRaw.style),
      },
      examples,
      extraInstructions: text(raw.extraInstructions),
    },
  };
}
