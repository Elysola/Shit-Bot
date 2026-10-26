import { getConfig } from '@/config';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m',   // gray
  INFO: '\x1b[36m',    // cyan
  WARN: '\x1b[33m',    // yellow
  ERROR: '\x1b[31m',   // red
};
const RESET = '\x1b[0m';

const MIN_LEVEL: LogLevel = 'INFO';

function timestamp(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function shouldLog(level: LogLevel): boolean {
  if (level === 'DEBUG') {
    try { return !!getConfig().debugMode; } catch { return false; }
  }
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function format(level: LogLevel, module: string, msg: string, ...args: any[]): void {
  if (!shouldLog(level)) return;
  const prefix = `${timestamp()} [${LEVEL_COLORS[level]}${level}${RESET}] [${module}]`;
  if (args.length > 0) {
    console.log(prefix, msg, ...args);
  } else {
    console.log(prefix, msg);
  }
}

export const logger = {
  debug: (module: string, msg: string, ...args: any[]) => format('DEBUG', module, msg, ...args),
  info: (module: string, msg: string, ...args: any[]) => format('INFO', module, msg, ...args),
  warn: (module: string, msg: string, ...args: any[]) => format('WARN', module, msg, ...args),
  error: (module: string, msg: string, ...args: any[]) => format('ERROR', module, msg, ...args),
};
