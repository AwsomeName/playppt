import { describe, expect, it } from 'vitest';

import { transition, compositeStateString } from './domain/state-machine.js';
import type { FsmState } from './types/session.js';

const idle0: FsmState = { top: 'idle', presentingSub: null, currentPage: 0 };
const tpg = 12;

describe('transition (M1 FSM)', () => {
  it('idle + START -> presenting.narrating @1', () => {
    const r = transition(idle0, { type: 'START' }, { totalPages: tpg, advanceMode: 'manual' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.top).toBe('presenting');
    expect(r.next.presentingSub).toBe('narrating');
    expect(r.next.currentPage).toBe(1);
    expect(compositeStateString(r.next)).toBe('presenting.narrating');
  });

  it('rejects idle + NEXT (guard)', () => {
    const r = transition(idle0, { type: 'NEXT' }, { totalPages: tpg, advanceMode: 'manual' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/空闲/);
  });

  it('NEXT/PREV in presenting changes page, clamps boundary', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 3, advanceMode: 'manual' });
    if (!s0.ok) throw new Error('start');
    let s: FsmState = s0.next;
    for (let step = 0; step < 2; step += 1) {
      const tr = transition(s, { type: 'NEXT' }, { totalPages: 3, advanceMode: 'manual' });
      expect(tr.ok).toBe(true);
      if (!tr.ok) break;
      s = tr.next;
    }
    expect(s.currentPage).toBe(3);
    const last = transition(s, { type: 'NEXT' }, { totalPages: 3, advanceMode: 'manual' });
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.next.currentPage).toBe(3);
      expect(last.notice).toBeDefined();
    }
    const first = transition({ ...s, currentPage: 1 }, { type: 'PREV' }, { totalPages: 3, advanceMode: 'manual' });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.next.currentPage).toBe(1);
    }
  });

  it('GOTO clamps to [1,totalPages]', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 5, advanceMode: 'manual' });
    if (!s0.ok) throw new Error('start');
    const g0 = transition(s0.next, { type: 'GOTO', page: -3 }, { totalPages: 5, advanceMode: 'manual' });
    expect(g0.ok).toBe(true);
    if (g0.ok) expect(g0.next.currentPage).toBe(1);
    if (!g0.ok) return;
    const g99 = transition(
      s0.next,
      { type: 'GOTO', page: 9999 },
      { totalPages: 5, advanceMode: 'manual' },
    );
    expect(g99.ok).toBe(true);
    if (g99.ok) expect(g99.next.currentPage).toBe(5);
  });

  it('PAUSE, NEXT while paused, then RESUME', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 5, advanceMode: 'manual' });
    if (!s0.ok) throw new Error('start');
    const p0 = transition(s0.next, { type: 'PAUSE' }, { totalPages: 5, advanceMode: 'manual' });
    expect(p0.ok).toBe(true);
    if (!p0.ok) return;
    expect(p0.next.top).toBe('paused');
    const n1 = transition(p0.next, { type: 'NEXT' }, { totalPages: 5, advanceMode: 'manual' });
    expect(n1.ok).toBe(true);
    if (!n1.ok) return;
    expect(n1.next.currentPage).toBe(2);
    expect(n1.next.top).toBe('paused');
    const r1 = transition(n1.next, { type: 'RESUME' }, { totalPages: 5, advanceMode: 'manual' });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.next.top).toBe('presenting');
      expect(r1.next.currentPage).toBe(2);
    }
  });

  it('idle STOP -> end', () => {
    const e = transition(idle0, { type: 'STOP' }, { totalPages: 5, advanceMode: 'manual' });
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.next.top).toBe('end');
  });

  it('TTS_DONE: manual -> waiting_confirm, auto -> auto_advance', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 2, advanceMode: 'manual' });
    if (!s0.ok) throw new Error();
    const t1 = transition(
      s0.next,
      { type: 'TTS_DONE' },
      { totalPages: 2, advanceMode: 'manual' },
    );
    expect(t1.ok).toBe(true);
    if (t1.ok) expect(t1.next.presentingSub).toBe('waiting_confirm');
    const s1 = transition(idle0, { type: 'START' }, { totalPages: 2, advanceMode: 'auto' });
    if (!s1.ok) throw new Error();
    const t2 = transition(s1.next, { type: 'TTS_DONE' }, { totalPages: 2, advanceMode: 'auto' });
    expect(t2.ok).toBe(true);
    if (t2.ok) expect(t2.next.presentingSub).toBe('auto_advance');
  });

  it('TTS_FAILED -> waiting_confirm', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 2, advanceMode: 'auto' });
    if (!s0.ok) return;
    const t = transition(s0.next, { type: 'TTS_FAILED' }, { totalPages: 2, advanceMode: 'auto' });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.next.presentingSub).toBe('waiting_confirm');
  });

  it('rejects any event in end (except that end ignores)', () => {
    const sEnd: FsmState = { top: 'end', presentingSub: null, currentPage: 2 };
    const n = transition(sEnd, { type: 'NEXT' }, { totalPages: 2, advanceMode: 'manual' });
    expect(n.ok).toBe(false);
  });

  it('M3: presenting + QUESTION_DETECTED -> qa', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 5, advanceMode: 'manual' });
    if (!s0.ok) throw new Error();
    const q = transition(
      s0.next,
      { type: 'QUESTION_DETECTED' },
      { totalPages: 5, advanceMode: 'manual' },
    );
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.next.top).toBe('qa');
      expect(q.next.currentPage).toBe(1);
    }
  });

  it('M5: presenting + ERROR_RECOVERABLE -> interrupted', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 3, advanceMode: 'auto' });
    if (!s0.ok) return;
    const r = transition(s0.next, { type: 'ERROR_RECOVERABLE' }, { totalPages: 3, advanceMode: 'auto' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next.top).toBe('interrupted');
      expect(r.actions).toContain('errorRecoverableFromPresenting');
    }
  });

  it('M5: qa + ERROR_RECOVERABLE -> interrupted', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 3, advanceMode: 'manual' });
    if (!s0.ok) return;
    const q = transition(s0.next, { type: 'QUESTION_DETECTED' }, { totalPages: 3, advanceMode: 'manual' });
    if (!q.ok) return;
    const r = transition(q.next, { type: 'ERROR_RECOVERABLE' }, { totalPages: 3, advanceMode: 'manual' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next.top).toBe('interrupted');
      expect(r.actions).toContain('errorRecoverableFromQa');
    }
  });

  it('M3: qa + QA_DONE -> presenting 并恢复子状态', () => {
    const s0 = transition(idle0, { type: 'START' }, { totalPages: 3, advanceMode: 'auto' });
    if (!s0.ok) return;
    const tts = transition(s0.next, { type: 'TTS_DONE' }, { totalPages: 3, advanceMode: 'auto' });
    if (!tts.ok) return;
    const sQ = transition(tts.next, { type: 'QUESTION_DETECTED' }, { totalPages: 3, advanceMode: 'auto' });
    if (!sQ.ok) return;
    expect(sQ.next.top).toBe('qa');
    const d = transition(sQ.next, { type: 'QA_DONE' }, { totalPages: 3, advanceMode: 'auto', restorePresentingSub: 'auto_advance' });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.next.top).toBe('presenting');
      expect(d.next.presentingSub).toBe('auto_advance');
    }
  });
});
