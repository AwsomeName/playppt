import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('session-audit-log', () => {
  afterEach(() => {
    delete process.env.PPT_SESSION_LOG_DIR;
    vi.resetModules();
  });

  it('append then read NDJSON lines', async () => {
    const dir = join(tmpdir(), `ppt-sal-${Date.now()}`);
    process.env.PPT_SESSION_LOG_DIR = dir;
    vi.resetModules();
    const { appendSessionAudit, readSessionAuditLines } = await import('./session-audit-log.js');
    const sid = randomUUID();
    await appendSessionAudit(sid, { type: 'unit', n: 42 });
    const rows = await readSessionAuditLines(sid);
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe('unit');
    expect(rows[0]!.n).toBe(42);
  });
});
