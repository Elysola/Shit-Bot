import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, saveConfig, reloadConfig, getEffectiveGroups, normalizePrivilegedIntents } from '@/config';
import { getRecentTweets, getSentCount } from '@/storage';
import { getLoadedPlugins } from '@/plugins';
import { sendForApproval } from '@/approval';
import { AppConfig, GroupConfig, PluginConfigEntry, ProcessedTweet } from '@/types';
import { logger } from '@/logger';

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
  if (cfg.debugMode) return true;
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

const MASK = '••••••••';
// 插件配置里的密钥字段（如 ai-chat 的 apiKey、webSearch.apiKey、memory.extractor.apiKey、embedding.apiKey）
const SECRET_KEY = /(apikey|token|secret|password)$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 递归把密钥字段换成掩码（有值才掩码，空值保持空） */
function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEY.test(k) && typeof val === 'string' ? (val ? MASK : '') : maskSecrets(val);
  }
  return out;
}

/** 保存时：掩码或空值视为"不修改"，换回原来的值 */
function restoreSecrets(incoming: unknown, prev: unknown): unknown {
  // 数组按下标对应还原（maskSecrets 也会进入数组）
  if (Array.isArray(incoming)) {
    const before = Array.isArray(prev) ? prev : [];
    return incoming.map((v, i) => restoreSecrets(v, before[i]));
  }
  if (!isPlainObject(incoming)) return incoming;
  const before = isPlainObject(prev) ? prev : {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(incoming)) {
    if (SECRET_KEY.test(k) && (val === MASK || val === '') && typeof before[k] === 'string') out[k] = before[k];
    else out[k] = restoreSecrets(val, before[k]);
  }
  return out;
}

export function maskPlugin(p: PluginConfigEntry): PluginConfigEntry {
  return p.options ? { ...p, options: maskSecrets(p.options) as Record<string, any> } : p;
}

export function restorePlugins(incoming: PluginConfigEntry[], prev: PluginConfigEntry[]): PluginConfigEntry[] {
  return incoming.map((p) => {
    const old = prev.find((x) => x.name === p.name);
    return p.options && old?.options ? { ...p, options: restoreSecrets(p.options, old.options) as Record<string, any> } : p;
  });
}

function sanitizeConfigForAPI(cfg: AppConfig): any {
  return {
    users: [],
    groups: cfg.groups || [],
    discord: { ...cfg.discord, token: cfg.discord.token ? '••••••••' : '' },
    telegram: { ...cfg.telegram, token: cfg.telegram.token ? '••••••••' : '' },
    onebot: { ...cfg.onebot, token: cfg.onebot?.token ? '••••••••' : '', secret: cfg.onebot?.secret ? '••••••••' : '' },
    twitter: {
      ...cfg.twitter,
      authToken: cfg.twitter.authToken ? '••••••••' : '',
      ct0: cfg.twitter.ct0 ? '••••••••' : '',
      password: cfg.twitter.password ? '••••••••' : '',
      totpSecret: cfg.twitter.totpSecret ? '••••••••' : '',
    },
    webui: { ...cfg.webui, password: cfg.webui.password ? '••••••••' : '' },
    plugins: (cfg.plugins || []).map(maskPlugin),
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
      if (body.onebot !== undefined) {
        cfg.onebot = { ...cfg.onebot, ...body.onebot };
        if (body.onebot.token && body.onebot.token !== '••••••••') cfg.onebot.token = body.onebot.token;
        if (body.onebot.secret && body.onebot.secret !== '••••••••') cfg.onebot.secret = body.onebot.secret;
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
      if (body.plugins !== undefined) cfg.plugins = Array.isArray(body.plugins) ? restorePlugins(body.plugins, cfg.plugins || []) : cfg.plugins;

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
        onebotEnabled: cfg.onebot?.enabled ?? false,
        approvalEnabled: cfg.enableApproval,
      });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/plugins') {
      const loaded = getLoadedPlugins();
      sendJSON(res, loaded.map(p => ({
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        author: p.manifest.author,
        enabled: p.config?.enabled !== false,
        options: maskSecrets(p.config?.options || {}),
      })));
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/debug/test-tweet') {
      const body = JSON.parse(req.body || '{}');
      const tweetUrl = body.url;
      const content = body.content || '这是一条测试推文';
      const author = body.author || 'test_user';
      const authorName = body.authorName || 'Test User';
      const targetTag = body.target || undefined;
      const useMockImage = body.mockImage === true;

      if (!tweetUrl && !body.mock) {
        sendError(res, '需要 url 或 mock: true');
        return;
      }

      const tweet: ProcessedTweet = {
        id: body.mock ? `mock_${Date.now()}` : (tweetUrl?.match(/\/status\/(\d+)/)?.[1] || `${Date.now()}`),
        author,
        authorName,
        content,
        url: tweetUrl || `https://x.com/${author}/status/${Date.now()}`,
        publishedAt: new Date(),
        mediaUrls: body.mediaUrls || [],
        isRetweet: false,
        isReply: false,
        matchedUser: { username: '*' },
        passedFilters: true,
        filterReasons: [],
        _skipUserFilter: true,
      };

      logger.info("Web", `[调试] 手动发送测试推文: ${tweet.url}${targetTag ? ` (目标: ${targetTag})` : ''}${useMockImage ? ' (Mock 图片)' : ''}`);

      if (useMockImage) {
        const { renderMockImage } = await import('@/renderer');
        const { cacheImage } = await import('@/storage');
        const imgBuf = await renderMockImage(tweet);
        cacheImage(tweet.id, imgBuf);
      }

      const config = getConfig();

      if (config.enableApproval) {
        await sendForApproval(tweet);
      } else {
        const { sendToAllGroups } = await import('@/approval');
        await sendToAllGroups(tweet, targetTag);
      }

      sendJSON(res, { success: true, tweetId: tweet.id, target: targetTag || 'all', mockImage: useMockImage });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/debug/approve') {
      const body = JSON.parse(req.body || '{}');
      const approvalId = body.approvalId;
      const reject = body.reject === true;

      if (!approvalId) {
        sendError(res, '需要 approvalId');
        return;
      }

      logger.info("Web", `[调试] API 审批: ${reject ? '拒绝' : '批准'} ${approvalId}`);
      const { handleOneBotApproval } = await import('@/approval');
      const groupId = body.groupId || 0;
      await handleOneBotApproval(approvalId, 0, groupId, reject);
      sendJSON(res, { success: true, action: reject ? 'rejected' : 'approved' });
      return;
    }

    sendError(res, '未找到', 404);
  } catch (error) {
    logger.error("Web", 'API 错误:', error);
    sendError(res, '服务器内部错误', 500);
  }
}

export function startWebServer(): http.Server {
  const cfg = getConfig();

  if (!cfg.webui.enabled) {
      logger.info("Web", 'WebUI 已在配置中禁用');
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
  logger.info("Web", `\nWebUI 访问地址: http://${cfg.webui.host}:${cfg.webui.port}`);
  if (cfg.webui.password) {
    logger.info("Web", 'WebUI 密码保护已启用');
    }
  });

  return server;
}
