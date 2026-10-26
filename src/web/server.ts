import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, saveConfig, reloadConfig, getEffectiveGroups, normalizeAiConfig, normalizePrivilegedIntents } from '../config';
import { getRecentTweets, getSentCount } from '../storage';
import { AppConfig, GroupConfig } from '../types';

interface IncomingMessage extends http.IncomingMessage {
  body?: string;
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { req.body = data; resolve(data); });
  });
}

function sendJSON(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, message: string, status = 400): void {
  sendJSON(res, { error: message }, status);
}

function checkAuth(req: IncomingMessage): boolean {
  const cfg = getConfig();
  if (!cfg.webui.password) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const encoded = auth.replace('Basic ', '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  const [, password] = decoded.split(':');
  return password === cfg.webui.password;
}

function requireAuth(_req: IncomingMessage, res: http.ServerResponse): boolean {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="ShitBot WebUI"',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ error: '未授权' }));
  return false;
}

/** 掩码或空值都视为"不修改该密钥"（未提供该字段时同样保留旧值） */
function isMaskedOrEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === '••••••••';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 递归合并普通对象；数组和标量直接以 patch 为准。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function sanitizeConfigForAPI(cfg: AppConfig): any {
  return {
    users: [],
    groups: cfg.groups || [],
    discord: { ...cfg.discord, token: cfg.discord.token ? '••••••••' : '' },
    telegram: { ...cfg.telegram, token: cfg.telegram.token ? '••••••••' : '' },
    twitter: {
      ...cfg.twitter,
      authToken: cfg.twitter.authToken ? '••••••••' : '',
      ct0: cfg.twitter.ct0 ? '••••••••' : '',
      password: cfg.twitter.password ? '••••••••' : '',
      totpSecret: cfg.twitter.totpSecret ? '••••••••' : '',
    },
    webui: { ...cfg.webui, password: cfg.webui.password ? '••••••••' : '' },
    ai: {
      ...cfg.ai,
      apiKey: cfg.ai.apiKey ? '••••••••' : '',
      webSearch: { ...cfg.ai.webSearch, apiKey: cfg.ai.webSearch?.apiKey ? '••••••••' : '' },
      embedding: { ...cfg.ai.embedding, apiKey: cfg.ai.embedding.apiKey ? '••••••••' : '' },
      memory: {
        ...cfg.ai.memory,
        extractor: { ...cfg.ai.memory.extractor, apiKey: cfg.ai.memory.extractor.apiKey ? '••••••••' : '' },
      },
    },
    enableApproval: cfg.enableApproval,
    sendAsImage: cfg.sendAsImage,
    xToImageApiUrl: cfg.xToImageApiUrl,
    xToImageApiToken: cfg.xToImageApiToken ? '••••••••' : '',
    xToImageApiTheme: cfg.xToImageApiTheme,
    imageCacheTtlMinutes: cfg.imageCacheTtlMinutes,
    pollIntervalMinutes: cfg.pollIntervalMinutes,
    maxPostsPerFetch: cfg.maxPostsPerFetch,
    maxTweetAgeMinutes: cfg.maxTweetAgeMinutes,
  };
}

function resolveUIPath(): string {
  const cwdPath = path.join(process.cwd(), 'ui.html');
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.join(__dirname, 'ui.html');
}

function serveUI(res: http.ServerResponse): void {
  const uiPath = resolveUIPath();
  try {
    const html = fs.readFileSync(uiPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>ShitBot</title></head><body><h1>UI 文件未找到</h1></body></html>`);
  }
}

async function handleAPI(req: IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  if (!checkAuth(req)) {
    requireAuth(req, res);
    return;
  }

  await parseBody(req);

  try {
    if (req.method === 'GET' && urlPath === '/api/config') {
      const cfg = getConfig();
      sendJSON(res, sanitizeConfigForAPI(cfg));
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/config/full') {
      sendJSON(res, getConfig());
      return;
    }

    if (req.method === 'PUT' && urlPath === '/api/config') {
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();

      if (body.discord !== undefined) {
        // privilegedIntents 是嵌套对象：只改请求里给出的那一项，另一项保持原值（否则重启后会变回 auto）
        const intents = { ...cfg.discord.privilegedIntents, ...(body.discord.privilegedIntents ?? {}) };
        cfg.discord = { ...cfg.discord, ...body.discord, privilegedIntents: normalizePrivilegedIntents(intents) };
        if (body.discord.token === '••••••••' || body.discord.token === '') {
          delete (body.discord as any).token;
        }
        if (body.discord.token && body.discord.token !== '••••••••' && body.discord.token !== cfg.discord.token) {
          cfg.discord.token = body.discord.token;
        }
      }
      if (body.telegram !== undefined) {
        cfg.telegram = { ...cfg.telegram, ...body.telegram };
        if (body.telegram.token && body.telegram.token !== '••••••••' && body.telegram.token !== cfg.telegram.token) {
          cfg.telegram.token = body.telegram.token;
        }
      }
      if (body.twitter !== undefined) {
        cfg.twitter = { ...cfg.twitter, ...body.twitter };
        if (body.twitter.authToken && body.twitter.authToken !== '••••••••') cfg.twitter.authToken = body.twitter.authToken;
        if (body.twitter.ct0 && body.twitter.ct0 !== '••••••••') cfg.twitter.ct0 = body.twitter.ct0;
        if (body.twitter.password && body.twitter.password !== '••••••••') cfg.twitter.password = body.twitter.password;
        if (body.twitter.totpSecret && body.twitter.totpSecret !== '••••••••') cfg.twitter.totpSecret = body.twitter.totpSecret;
      }
      if (body.webui !== undefined) {
        cfg.webui = { ...cfg.webui, ...body.webui };
        if (body.webui.password && body.webui.password !== '••••••••') cfg.webui.password = body.webui.password;
      }
      if (body.ai !== undefined) {
        const prevAi = cfg.ai;
        // 深合并后再规范化：只传了部分嵌套字段（如 ai.memory.extractor.model）时，其余字段与默认值都保留
        const merged = normalizeAiConfig(deepMerge(prevAi, body.ai));
        if (!body.ai.apiKey || body.ai.apiKey === '••••••••') merged.apiKey = prevAi.apiKey;
        if (merged.webSearch && isMaskedOrEmpty(body.ai.webSearch?.apiKey)) {
          merged.webSearch.apiKey = prevAi.webSearch?.apiKey || '';
        }
        if (isMaskedOrEmpty(body.ai.embedding?.apiKey)) merged.embedding.apiKey = prevAi.embedding.apiKey;
        if (isMaskedOrEmpty(body.ai.memory?.extractor?.apiKey)) {
          merged.memory.extractor.apiKey = prevAi.memory.extractor.apiKey;
        }
        cfg.ai = merged;
      }
      if (body.enableApproval !== undefined) cfg.enableApproval = body.enableApproval;
      if (body.sendAsImage !== undefined) cfg.sendAsImage = body.sendAsImage;
      if (body.xToImageApiUrl !== undefined) cfg.xToImageApiUrl = body.xToImageApiUrl;
      if (body.xToImageApiToken !== undefined && body.xToImageApiToken !== '••••••••') cfg.xToImageApiToken = body.xToImageApiToken;
      if (body.xToImageApiTheme !== undefined) cfg.xToImageApiTheme = body.xToImageApiTheme;
      if (body.imageCacheTtlMinutes !== undefined) cfg.imageCacheTtlMinutes = body.imageCacheTtlMinutes;
      if (body.pollIntervalMinutes !== undefined) cfg.pollIntervalMinutes = body.pollIntervalMinutes;
      if (body.maxPostsPerFetch !== undefined) cfg.maxPostsPerFetch = body.maxPostsPerFetch;
      if (body.maxTweetAgeMinutes !== undefined) cfg.maxTweetAgeMinutes = body.maxTweetAgeMinutes;
      if (body.groups !== undefined) cfg.groups = body.groups;

      saveConfig(cfg);
      sendJSON(res, { success: true });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/groups') {
      const cfg = getConfig();
      sendJSON(res, cfg.groups || []);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/groups') {
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();

      if (!body.name) {
        sendError(res, '群组名称为必填项');
        return;
      }

      if (!cfg.groups) cfg.groups = [];
      if (cfg.groups.find(g => g.name === body.name)) {
        sendError(res, '群组已存在');
        return;
      }

      const group: GroupConfig = {
        name: body.name,
        users: body.users || [],
        telegram: body.telegram,
        discord: body.discord,
        approval: body.approval,
        blockedUsers: body.blockedUsers || [],
      };

      cfg.groups.push(group);
      saveConfig(cfg);
      sendJSON(res, { success: true, group });
      return;
    }

    if (req.method === 'DELETE' && urlPath.startsWith('/api/groups/')) {
      const gname = urlPath.replace('/api/groups/', '');
      const cfg = getConfig();
      const idx = (cfg.groups || []).findIndex(g => g.name === gname);

      if (idx === -1) {
        sendError(res, '群组未找到', 404);
        return;
      }

      cfg.groups!.splice(idx, 1);
      saveConfig(cfg);
      sendJSON(res, { success: true });
      return;
    }

    if (req.method === 'PUT' && urlPath.startsWith('/api/groups/')) {
      const gname = urlPath.replace('/api/groups/', '');
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();

      if (!cfg.groups) {
        sendError(res, '未配置任何群组', 404);
        return;
      }

      const group = cfg.groups.find(g => g.name === gname);
      if (!group) {
        sendError(res, '群组未找到', 404);
        return;
      }

      if (body.name && body.name !== gname) {
        if (cfg.groups.find(g => g.name === body.name)) {
          sendError(res, '群组名称已被占用');
          return;
        }
        group.name = body.name;
      }
      if (body.telegram !== undefined) group.telegram = body.telegram;
      if (body.discord !== undefined) group.discord = body.discord;
      if (body.approval !== undefined) group.approval = body.approval;
      if (body.blockedUsers !== undefined) group.blockedUsers = body.blockedUsers;
      if (body.users !== undefined) group.users = body.users;

      saveConfig(cfg);
      sendJSON(res, { success: true, group });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/tweets') {
      const url = new URL(req.url || '', 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const tweets = getRecentTweets(limit);
      sendJSON(res, tweets);
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/stats') {
      const cfg = getConfig();
      const groups = getEffectiveGroups();
      const uniqueUsers = new Set<string>();
      for (const g of groups) {
        for (const u of (g.users || [])) {
          uniqueUsers.add(u.username);
        }
      }
      sendJSON(res, {
        userCount: uniqueUsers.size,
        sentCount: getSentCount(),
        pollInterval: cfg.pollIntervalMinutes,
        discordEnabled: cfg.discord.enabled,
        telegramEnabled: cfg.telegram.enabled,
        approvalEnabled: cfg.enableApproval,
      });
      return;
    }

    sendError(res, '未找到', 404);
  } catch (error) {
    console.error('API 错误:', error);
    sendError(res, '服务器内部错误', 500);
  }
}

export function startWebServer(): http.Server {
  const cfg = getConfig();

  if (!cfg.webui.enabled) {
      console.log('WebUI 已在配置中禁用');
    const dummy = http.createServer();
    return dummy;
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const urlPath = url.split('?')[0];

    if (urlPath === '/' || urlPath === '/index.html') {
      serveUI(res);
      return;
    }

    if (urlPath.startsWith('/api/')) {
      await handleAPI(req, res, urlPath);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(cfg.webui.port, cfg.webui.host, () => {
  console.log(`\nWebUI 访问地址: http://${cfg.webui.host}:${cfg.webui.port}`);
  if (cfg.webui.password) {
    console.log('WebUI 密码保护已启用');
    }
  });

  return server;
}
