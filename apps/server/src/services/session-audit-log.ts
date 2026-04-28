import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function filePath(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  return join(config.sessionLogsDir, `${sessionId}.ndjson`);
}

/**
 * 追加一行 NDJSON（失败只打 error，不抛，避免拖垮主链路）。
 */
export async function appendSessionAudit(sessionId: string, entry: Record<string, unknown>): Promise<void> {
  const fp = filePath(sessionId);
  if (!fp) return;
  try {
    await mkdir(config.sessionLogsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), sessionId, ...entry }) + '\n';
    await appendFile(fp, line, 'utf8');
  } catch (e) {
    logger.error('session audit append failed', {
      sessionId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 导出复盘：按行解析 JSON，坏行跳过。 */
export async function readSessionAuditLines(sessionId: string): Promise<Record<string, unknown>[]> {
  const fp = filePath(sessionId);
  if (!fp) return [];
  try {
    const raw = await readFile(fp, 'utf8');
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        logger.warn('session audit skip bad line', { sessionId, preview: t.slice(0, 80) });
      }
    }
    return out;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    logger.error('session audit read failed', { sessionId, err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}
