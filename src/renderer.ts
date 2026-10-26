import sharp from 'sharp';
import { ProcessedTweet } from '@/types';
import { getConfig } from '@/config';
import { fetchTweetImage } from '@/xToImageApi';
import { logger } from '@/logger';

export async function initRenderer(): Promise<boolean> {
  const config = getConfig();
  if (config.xToImageApiUrl) {
    logger.info("Renderer", `X to Image API 已配置: ${config.xToImageApiUrl}`);
  } else {
    logger.info("Renderer", '未配置 X to Image API, 图片渲染已禁用');
  }
  return true;
}

export async function renderTweetImage(tweet: ProcessedTweet): Promise<Buffer | null> {
  const config = getConfig();

  if (config.xToImageApiUrl) {
    return fetchTweetImage(tweet);
  }

  return null;
}

export async function renderMockImage(tweet: ProcessedTweet): Promise<Buffer> {
  const width = 600;
  const height = 400;

  const lines: string[] = [
    `@${tweet.author}`,
    '',
    tweet.authorName,
    '',
    ...wrapText(tweet.content, 50),
    '',
    '─'.repeat(35),
    `Mock Tweet · ${tweet.publishedAt.toLocaleString('zh-CN')}`,
    tweet.url,
  ];

  const linesHtml = lines.map((line, i) =>
    `<div style="color:${i === 0 ? '#1d9bf0' : i === 1 ? '#8899a6' : '#e7e9ea'};font-family:monospace;font-size:14px;line-height:1.4;">${escapeHtml(line || '&nbsp;')}</div>`
  ).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#15202b"/>
  <foreignObject x="30" y="30" width="${width - 60}" height="${height - 60}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="padding:20px;background:#192734;border-radius:12px;">
      ${linesHtml}
    </div>
  </foreignObject>
</svg>`;

  const pngBuffer = await svgToPng(Buffer.from(svg), width, height);
  return pngBuffer;
}

function wrapText(text: string, maxLen: number): string[] {
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function svgToPng(svg: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(svg).resize(width, height).png().toBuffer();
}

export async function shutdownRenderer(): Promise<void> {
  logger.info("Renderer", '渲染器已关闭');
}
