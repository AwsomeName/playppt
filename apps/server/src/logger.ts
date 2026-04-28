type Level = 'info' | 'warn' | 'error' | 'debug';

function line(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const payload = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...meta,
  };
  const text = JSON.stringify(payload);
  if (level === 'error') {
    console.error(text);
  } else if (level === 'warn') {
    console.warn(text);
  } else {
    console.log(text);
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => line('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => line('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => line('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => line('debug', msg, meta),
};
