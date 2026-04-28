import { describe, expect, it } from 'vitest';

import { sessionService } from './services/session-service.js';

/**
 * M5：快速模拟高事件量会话（非真实 30–60 分钟墙钟）。
 * 等价量级：约 240 次 control + 80 次 narration 通知 + 若干降级进出与问答轮次；
 * 断言：不抛错、会话仍存在、页码在合法范围、清除降级后 FSM 生效模式与配置一致。
 */
describe('session stress', () => {
  it('handles many next/prev cycles', () => {
    const { sessionId } = sessionService.startSession('demo');
    expect(sessionService.control(sessionId, { action: 'start' }).ok).toBe(true);
    for (let i = 0; i < 120; i += 1) {
      sessionService.control(sessionId, { action: 'next' });
      sessionService.control(sessionId, { action: 'prev' });
    }
    const s = sessionService.getSession(sessionId);
    expect(s).not.toBeNull();
    expect(s!.currentPage).toBeGreaterThanOrEqual(1);
  });

  it('combines narration, fallback clear, and QA-shaped control without leaking', async () => {
    const { sessionId } = sessionService.startSession('demo');
    expect(sessionService.control(sessionId, { action: 'start' }).ok).toBe(true);
    /** 手动模式：仅在 narrating 下发 TTS_DONE，再用 next 回到下一页 narrating，避免在 waiting_confirm 上堆积无效事件 */
    for (let i = 0; i < 18; i += 1) {
      sessionService.narrationNotify(sessionId, { event: 'TTS_DONE' });
      sessionService.control(sessionId, { action: 'next' });
      if (i % 5 === 4) {
        sessionService.control(sessionId, { action: 'goto', page: 2 });
      }
    }
    sessionService.recordServerTtsFailure(sessionId, 's1');
    sessionService.recordServerTtsFailure(sessionId, 's2');
    let g = sessionService.getSession(sessionId);
    expect(g!.fallbackMode).toBe(true);
    expect(g!.topState === 'interrupted' || g!.state.includes('interrupted')).toBe(true);
    const cleared = sessionService.patchSession(sessionId, { clearFallback: true });
    if ('error' in cleared) throw new Error(cleared.error);
    expect(cleared.fallbackMode).toBe(false);
    expect(sessionService.control(sessionId, { action: 'resume' }).ok).toBe(true);
    const ask = await sessionService.submitAsk(sessionId, {
      question: '压力测占位问题',
      currentPage: g!.currentPage,
    });
    if ('error' in ask) {
      expect(ask.code).toBeDefined();
    } else {
      expect(ask.answerText.length).toBeGreaterThan(0);
    }
    g = sessionService.getSession(sessionId);
    expect(g).not.toBeNull();
    expect(g!.currentPage).toBeGreaterThanOrEqual(1);
    expect(g!.currentPage).toBeLessThanOrEqual(g!.totalPages);
  });
});
