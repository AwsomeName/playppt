import { describe, expect, it } from 'vitest';

import { parseUserIntent } from './domain/intent-parser.js';

const baseCtx = (opts?: { totalPages?: number; hasChapters?: boolean }) => ({
  totalPages: opts?.totalPages ?? 10,
  hasChapters: opts?.hasChapters ?? false,
  chapters: opts?.hasChapters
    ? [
        { id: '1', title: '概述', startPage: 1 },
        { id: '2', title: '实现', startPage: 4 },
      ]
    : undefined,
});

describe('parseUserIntent (M3)', () => {
  it('同义：下一页/下一张 -> next', () => {
    const r1 = parseUserIntent('帮我下一页', baseCtx());
    const r2 = parseUserIntent('下一张', baseCtx());
    expect(r1).toMatchObject({ kind: 'command', action: 'next' });
    expect(r2).toMatchObject({ kind: 'command', action: 'next' });
  });

  it('同义：上一页 -> prev', () => {
    const r = parseUserIntent('回到上一页', baseCtx());
    expect(r).toMatchObject({ kind: 'command', action: 'prev' });
  });

  it('同义：暂停/继续/结束', () => {
    expect(parseUserIntent('先暂停', baseCtx())).toMatchObject({ kind: 'command', action: 'pause' });
    expect(parseUserIntent('继续', baseCtx())).toMatchObject({ kind: 'command', action: 'resume' });
    expect(parseUserIntent('结束', baseCtx())).toMatchObject({ kind: 'command', action: 'stop' });
  });

  it('goto 第一页/最后一页', () => {
    const r1 = parseUserIntent('到第一页', baseCtx({ totalPages: 8 }));
    const r2 = parseUserIntent('最后一页', baseCtx({ totalPages: 8 }));
    expect(r1).toMatchObject({ kind: 'command', action: 'goto', page: 1 });
    expect(r2).toMatchObject({ kind: 'command', action: 'goto', page: 8 });
  });

  it('无 chapters 时「去第三章」不作为稳定 goto', () => {
    const r = parseUserIntent('去第三章', baseCtx({ hasChapters: false, totalPages: 20 }));
    expect(r.kind).toBe('ask');
  });

  it('有 chapters 时「去第2章」匹配章 id -> goto(章首)', () => {
    const r = parseUserIntent('去第2章', baseCtx({ hasChapters: true, totalPages: 20 }));
    expect(r).toMatchObject({ kind: 'command', action: 'goto', page: 4 });
  });

  it('非命令长句 -> ask', () => {
    const r = parseUserIntent('这页和前面几页的数据口径为什么不一致？', baseCtx());
    expect(r).toMatchObject({ kind: 'ask' });
  });
});
