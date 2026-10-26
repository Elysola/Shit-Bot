import { getAiConfig } from './config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_FETCH_BYTES = 10 * 1024 * 1024;

function ipBlockedV4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipBlocked(ip: string): boolean {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // IPv4-mapped/compatible in dotted form: ::ffff:127.0.0.1 / ::127.0.0.1
  const dotted = s.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) return ipBlockedV4(dotted[1]);
  // IPv4-mapped in hex form: ::ffff:7f00:1
  const hex = s.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return ipBlockedV4(s);
  if (s === '::1' || s === '::') return true;
  if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(s)) return true; // ULA fc00::/7
  return false;
}

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http(s) 链接');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('不允许的端口');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('禁止访问内网/本地地址');
  }
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (addrs.length === 0 || addrs.some(ipBlocked)) throw new Error('禁止访问内网/本地地址');
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      out += decoder.decode(value.subarray(0, remaining), { stream: true });
      await reader.cancel().catch(() => {});
      break;
    }
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// 二进制限量读取：超过上限直接判失败返回 null（图片不能像文本那样截断——截断即损坏）
async function readBodyCappedBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * 本机下载图片并转成 base64 data URI，避免把图片直链交给上游网关去下载。
 * 上游网关(尤其中转到 Google AI Studio 这类)下载直链时常因 SSRF/IPv6/防盗链而失败，
 * 被包成 HTTP 500 convert_request_failed，或干脆挂死直到超时；本机内联可彻底绕过这一步。
 * 任何失败(不安全链接、非图片、超限、HTTP 错误、超时)都抛出，交调用方降级。
 */
export async function fetchImageAsDataUri(
  url: string,
  maxBytes: number
): Promise<{ dataUri: string; bytes: number }> {
  let current = url;
  let res: Response | undefined;

  for (let hop = 0; hop < 5; hop++) {
    await assertSafeUrl(current);
    res = await fetchWithTimeout(
      current,
      { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'image/*,*/*' } },
      15000
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }

  if (!res) throw new Error('图片下载失败');
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ctype.startsWith('image/')) {
    res.body?.cancel().catch(() => {});
    throw new Error(`目标不是图片 (content-type=${ctype || '未知'})`);
  }
  const bytes = await readBodyCappedBytes(res, maxBytes);
  if (!bytes) throw new Error(`图片超过大小上限 (${Math.round(maxBytes / 1024)}KB)`);
  return { dataUri: `data:${ctype};base64,${Buffer.from(bytes).toString('base64')}`, bytes: bytes.byteLength };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[e.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseDuckDuckGo(html: string, max: number): SearchResult[] {
  const anchorRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const anchors: Array<{ pos: number; url: string; title: string }> = [];
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    let url = decodeEntities(am[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        // keep raw url
      }
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    anchors.push({ pos: am.index, url, title: stripTags(am[2]) });
  }

  const snippets: Array<{ pos: number; text: string }> = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push({ pos: sm.index, text: stripTags(sm[1]) });
  }

  const results: SearchResult[] = [];
  for (let k = 0; k < anchors.length && results.length < max; k++) {
    const a = anchors[k];
    if (!a.title || !/^https?:\/\//.test(a.url)) continue;
    const nextPos = k + 1 < anchors.length ? anchors[k + 1].pos : Infinity;
    const snip = snippets.find((s) => s.pos > a.pos && s.pos < nextPos);
    results.push({ title: a.title, url: a.url, snippet: snip ? snip.text : '' });
  }
  return results;
}

async function searchDuckDuckGo(query: string, max: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  return parseDuckDuckGo(html, max);
}

async function searchTavily(query: string, max: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: max, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || []).slice(0, max).map((r) => ({
    title: r.title || r.url || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
}

async function searchSerper(query: string, max: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: max }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (data.organic || []).slice(0, max).map((r) => ({
    title: r.title || r.link || '',
    url: r.link || '',
    snippet: r.snippet || '',
  }));
}

async function searchBrave(query: string, max: number, apiKey: string): Promise<SearchResult[]> {
  const url =
    'https://api.search.brave.com/res/v1/web/search?' +
    new URLSearchParams({ q: query, count: String(max) }).toString();
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results || []).slice(0, max).map((r) => ({
    title: r.title || r.url || '',
    url: r.url || '',
    snippet: r.description || '',
  }));
}

async function searchSearxng(query: string, max: number, baseUrl: string): Promise<SearchResult[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/search?` + new URLSearchParams({ q: query, format: 'json' }).toString();
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || []).slice(0, max).map((r) => ({
    title: r.title || r.url || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
}

export async function webSearch(query: string, maxResults?: number): Promise<SearchResult[]> {
  const cfg = getAiConfig().webSearch;
  const provider = cfg?.provider || 'duckduckgo';
  const fallbackMax = cfg?.maxResults ?? 5;
  const reqMax = typeof maxResults === 'number' ? maxResults : parseInt(String(maxResults ?? ''), 10);
  const max = Math.max(1, Math.min(isFinite(reqMax) ? Math.floor(reqMax) : fallbackMax, 10));
  const apiKey = cfg?.apiKey || '';
  const q = String(query || '').trim();
  if (!q) return [];

  switch (provider) {
    case 'tavily':
      if (!apiKey) throw new Error('Tavily 需要配置 apiKey');
      return searchTavily(q, max, apiKey);
    case 'serper':
      if (!apiKey) throw new Error('Serper 需要配置 apiKey');
      return searchSerper(q, max, apiKey);
    case 'brave':
      if (!apiKey) throw new Error('Brave 需要配置 apiKey');
      return searchBrave(q, max, apiKey);
    case 'searxng':
      if (!cfg?.baseUrl) throw new Error('SearXNG 需要配置 baseUrl');
      return searchSearxng(q, max, cfg.baseUrl);
    case 'duckduckgo':
    default:
      return searchDuckDuckGo(q, max);
  }
}

/**
 * 从原始 HTML 里抽取图片直链：og:image / twitter:image 以及 <img src>（含 data-src 懒加载）。
 * 全部按 baseUrl 解析为绝对 http(s) 链接、去重并限量；data: 等非 http(s) 链接会被过滤。
 */
function extractPageImages(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(decodeEntities(raw.trim()), baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  // 优先 og:image / twitter:image（通常是页面主图）
  const metaRe = /<meta\b[^>]*>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) !== null) {
    const tag = mm[0];
    if (!/(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["']/i.test(tag)) continue;
    const c = tag.match(/content=["']([^"']+)["']/i);
    if (c) push(c[1]);
  }

  // 正文 <img>（src 或懒加载 data-src）
  const imgRe = /<img\b[^>]*>/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) !== null && out.length < 24) {
    const tag = im[0];
    // 懒加载页面常把真图放在 data-src/data-original，src 只是占位(常为 data: 或 1px)，故真图优先、src 兜底
    const lazy = tag.match(/\bdata-(?:src|original|lazy-src)=["']([^"']+)["']/i);
    const plain = tag.match(/\bsrc=["']([^"']+)["']/i);
    push(lazy?.[1] || plain?.[1]);
  }

  return out.slice(0, 12);
}

export async function fetchUrl(url: string): Promise<{ text: string; images: string[] }> {
  let current = url;
  let res: Response | undefined;

  for (let hop = 0; hop < 5; hop++) {
    await assertSafeUrl(current);
    res = await fetchWithTimeout(
      current,
      { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } },
      20000
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }

  if (!res) throw new Error('fetch 失败');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';

  // 链接本身就是一张图片：不读取二进制正文，直接提示模型用 read_image 查看
  if (ctype.startsWith('image/')) {
    res.body?.cancel().catch(() => {});
    return { text: '(目标链接本身是一张图片，可用 read_image 查看其内容)', images: [current] };
  }

  const raw = await readBodyCapped(res, MAX_FETCH_BYTES);

  if (ctype.includes('application/json') || /^\s*[{[]/.test(raw)) {
    return { text: raw, images: [] };
  }

  const images = extractPageImages(raw, current);

  let text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  text = stripTags(text);
  return { text: (title ? `# ${title}\n\n` : '') + text, images };
}