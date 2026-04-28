import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunQa } = vi.hoisted(() => ({
  mockRunQa: vi.fn(),
}));

vi.mock('./ai/qa-answer.js', () => ({
  runQaPipeline: mockRunQa,
}));

import { readSessionAuditLines } from './services/session-audit-log.js';
import { sessionService } from './services/session-service.js';

describe('M5 recoverable + logs contract', () => {
  beforeEach(() => {
    mockRunQa.mockReset();
  });

  it('LLM recoverable failure ends ask in interrupted with audit trail', async () => {
    mockRunQa.mockResolvedValue({
      answerText: '（降级）摘录回答',
      sourcePages: [1],
      confidence: 0.3,
      llmUnavailable: true,
      recoverableInfrastructureFailure: true,
      llmAttemptsUsed: 3,
    });
    const { sessionId } = sessionService.startSession('demo');
    expect(sessionService.control(sessionId, { action: 'start' }).ok).toBe(true);
    const r = await sessionService.submitAsk(sessionId, { question: '测试超时路径', currentPage: 1 });
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toContain('interrupted');
    expect(r.fallbackMode).toBe(true);
    const lines = await readSessionAuditLines(sessionId);
    const types = lines.map((x) => x.type as string);
    expect(types).toContain('error_recoverable');
    expect(types).toContain('qa_round_outcome');
  });

  it('consecutive server TTS failures trigger ERROR_RECOVERABLE', () => {
    const { sessionId } = sessionService.startSession('demo');
    expect(sessionService.control(sessionId, { action: 'start' }).ok).toBe(true);
    sessionService.recordServerTtsFailure(sessionId, 'e1');
    expect(sessionService.getSession(sessionId)!.topState).toBe('presenting');
    sessionService.recordServerTtsFailure(sessionId, 'e2');
    expect(sessionService.getSession(sessionId)!.topState).toBe('interrupted');
    expect(sessionService.getSession(sessionId)!.fallbackMode).toBe(true);
  });

  it('recordServerTtsSuccess clears streak', () => {
    const { sessionId } = sessionService.startSession('demo');
    sessionService.control(sessionId, { action: 'start' });
    sessionService.recordServerTtsFailure(sessionId, 'e1');
    sessionService.recordServerTtsSuccess(sessionId);
    sessionService.recordServerTtsFailure(sessionId, 'e3');
    expect(sessionService.getSession(sessionId)!.topState).toBe('presenting');
  });
});
