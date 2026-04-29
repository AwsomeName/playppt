import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { classifyTranscriptIntent } from '../ai/intent-classify.js';
import { checkEchoOverlap } from '../ai/echo-filter.js';
import { getTtsBackendHint } from '../ai/provider.js';
import { runQaPipeline } from '../ai/qa-answer.js';
import { config } from '../config.js';
import { appendSessionAudit } from './session-audit-log.js';
import { loadDemoPresentation, loadPresentation } from '../demo-loader.js';
import { parseUserIntent } from '../domain/intent-parser.js';
import { transition, compositeStateString } from '../domain/state-machine.js';
import type { FsmTransitionContext } from '../domain/fsm-options.js';
import { logger } from '../logger.js';
import { ensureSlidesConverted } from './pptx-converter.js';
import type { AdvanceMode, FsmState, FsmEvent, PageContext, PageStatus, PresentingSub } from '../types/session.js';
import type { DemoPage, DemoPresentation } from '../types/presentation.js';

export interface StartSessionResult {
  sessionId: string;
  totalPages: number;
  state: 'idle';
}

export interface ControlRequest {
  action: 'start' | 'next' | 'prev' | 'goto' | 'pause' | 'resume' | 'stop';
  page?: number;
  eventId?: string;
}

export interface ControlResult {
  ok: boolean;
  currentPage: number;
  state: string;
  message?: string;
}

export interface AskResult {
  answerText: string;
  sourcePages: number[];
  confidence: number;
  fallbackMode: boolean;
  state: string;
  currentPage: number;
}

export type InterpretResult =
  | { kind: 'control'; result: ControlResult; transcript: string }
  | { kind: 'ask_suggestion'; text: string; transcript: string; message: string }
  | { kind: 'noop'; reason: string; transcript: string };

export type VoicePipelineResult =
  | { kind: 'control'; transcript: string; result: ControlResult }
  | { kind: 'answered'; transcript: string; ask: AskResult }
  | { kind: 'suggest_ask'; transcript: string; text: string; message: string }
  | { kind: 'rejected'; transcript: string; message: string; code?: string }
  | {
      kind: 'ignored';
      transcript: string;
      reason: string;
      /** true：分类走了启发式（无 LLM key 或 LLM 失败） */
      classifierFallback: boolean;
    };

export interface SessionPageSnapshot {
  pageNo: number;
  status: PageStatus;
  narrationProgress: PageContext['narrationProgress'];
  dwellMs: number;
  qaCount: number;
}

export type TtsBackendHint = 'client' | 'volc' | 'openai' | 'disabled';

export interface SessionGetResult {
  sessionId: string;
  currentPage: number;
  state: string;
  subState: string | null;
  topState: FsmState['top'];
  mode: AdvanceMode;
  fallbackMode: boolean;
  updatedAt: string;
  lastError?: string;
  totalPages: number;
  title: string;
  presentationId: string;
  deckFile?: string;
  assetBaseUrl?: string;
  slideImagesBaseUrl?: string;
  slideImages?: import('../types/presentation.js').SlideImageEntry[];
  pages: SessionPageSnapshot[];
  pagesData: DemoPage[];
  /** 自动翻页前倒计时的秒数（M2+） */
  autoCountdownSec: number;
  /** 前端可选：无 OpenAI 时用 client（SpeechSynthesis）；有 key 时可用 openai */
  ttsBackend: TtsBackendHint;
  /** 关闭后前端不播 TTS（只保留状态机/接口） */
  narrationTtsEnabled: boolean;
  /** M5：降级时 FSM 实际按 manual 处理自动翻页；清除降级后可恢复用户所选 mode */
  advanceModeEffective: AdvanceMode;
  /** 是否允许通过 API 编辑 presentations 下 scripts/kb（受环境变量控制） */
  presentationEditorEnabled: boolean;
}

export interface SessionPatchResult {
  ok: boolean;
  currentPage: number;
  state: string;
  mode: AdvanceMode;
  fallbackMode: boolean;
  advanceModeEffective: AdvanceMode;
  message?: string;
}

const knownPresentations: Record<string, DemoPresentation> = {};

export function invalidatePresentationCache(presentationId: string): void {
  delete knownPresentations[presentationId];
}

function getPresentation(presentationId: string): DemoPresentation {
  if (knownPresentations[presentationId]) {
    return knownPresentations[presentationId]!;
  }
  try {
    const p = loadPresentation(config.presentationsDir, presentationId);
    knownPresentations[presentationId] = p;
    return p;
  } catch {
    if (presentationId !== 'demo') {
      throw new Error(`unknown presentation: ${presentationId}`);
    }
    const p = loadDemoPresentation(`${config.rootDir}/fixtures`);
    knownPresentations.demo = p;
    return p;
  }
}

function makePageContexts(pres: DemoPresentation): PageContext[] {
  return pres.pages.map((pg) => ({
    pageNo: pg.pageNo,
    status: 'unvisited' as const,
    narrationProgress: {
      totalChars: pg.script.length,
      playedChars: 0,
      playedDurationMs: 0,
      totalDurationMs: 0,
    },
    visitCount: 0,
    firstVisitAt: null,
    lastVisitAt: null,
    dwellMs: 0,
    qaHistory: [],
  }));
}

interface Session {
  id: string;
  presentation: DemoPresentation;
  pages: PageContext[];
  fsm: FsmState;
  /** 从 presenting 进入问答/中断时，用于恢复子态 */
  resumePresentingSub?: PresentingSub;
  advanceMode: AdvanceMode;
  fallbackMode: boolean;
  /** 4.8：服务端 OpenAI TTS 连续失败次数（成功后清零） */
  serverTtsFailureStreak: number;
  pageEnteredAtMs: number;
  updatedAt: string;
  lastError?: string;
  idempotencyOrder: string[];
  idempotencyResults: Map<string, ControlResult>;
}

const sessions = new Map<string, Session>();
const nowIso = () => new Date().toISOString();

const MAX_IDEMPOTENCY = 200;

function pushIdempotency(s: Session, key: string, r: ControlResult) {
  if (s.idempotencyResults.has(key)) {
    s.idempotencyResults.set(key, r);
    return;
  }
  s.idempotencyOrder.push(key);
  s.idempotencyResults.set(key, r);
  while (s.idempotencyOrder.length > MAX_IDEMPOTENCY) {
    const k = s.idempotencyOrder.shift()!;
    s.idempotencyResults.delete(k);
  }
}

function logFsm(
  s: Session,
  from: FsmState,
  to: FsmState,
  event: FsmEvent,
  eventId: string | undefined,
  extra?: Record<string, unknown>,
) {
  const payload = {
    kind: 'fsm_transition',
    sessionId: s.id,
    from: compositeStateString(from),
    to: compositeStateString(to),
    topFrom: from.top,
    topTo: to.top,
    subTo: to.presentingSub,
    event,
    eventId: eventId ?? null,
    timestamp: nowIso(),
    currentPage: to.currentPage,
    totalPages: s.presentation.totalPages,
    ...extra,
  };
  logger.info('fsm transition', payload);
  void appendSessionAudit(s.id, payload);
}

function toSnapshot(p: PageContext): SessionPageSnapshot {
  return {
    pageNo: p.pageNo,
    status: p.status,
    narrationProgress: p.narrationProgress,
    dwellMs: p.dwellMs,
    qaCount: p.qaHistory.length,
  };
}

function applyDwellOnLeave(s: Session, oldPage: number) {
  if (oldPage < 1) return;
  const idx = oldPage - 1;
  const cell = s.pages[idx];
  if (!cell) return;
  const add = Date.now() - s.pageEnteredAtMs;
  cell.dwellMs += add > 0 ? add : 0;
  if (cell.status === 'narrating' && s.fsm.top !== 'end') {
    cell.status = 'skipped';
  }
}

function enterPage(s: Session, newPage: number) {
  const safe = Math.min(Math.max(1, newPage), s.presentation.totalPages);
  s.pageEnteredAtMs = Date.now();
  const idx = safe - 1;
  const cell = s.pages[idx]!;
  const iso = nowIso();
  cell.visitCount += 1;
  if (!cell.firstVisitAt) {
    cell.firstVisitAt = iso;
  }
  cell.lastVisitAt = iso;
  if (s.fsm.top === 'end') return;
  cell.status = 'narrating' as PageStatus;
}

function applyPauseToPage(s: Session, atPage: number) {
  if (atPage < 1) return;
  const c = s.pages[atPage - 1];
  if (c?.status === 'narrating') c.status = 'narrate_paused';
}

function applyResumeToPage(s: Session) {
  const cp = s.fsm.currentPage;
  if (cp < 1) return;
  const c = s.pages[cp - 1];
  if (c?.status === 'narrate_paused' || c?.status === 'narrating') c.status = 'narrating';
}

function markPageNarrated(s: Session, atPage: number) {
  if (atPage < 1) return;
  const c = s.pages[atPage - 1];
  if (!c) return;
  c.status = 'narrated';
  c.narrationProgress.playedChars = c.narrationProgress.totalChars;
  c.narrationProgress.totalDurationMs = c.narrationProgress.totalDurationMs || c.narrationProgress.totalChars * 80;
}

function markTtsFailedOnPage(s: Session, atPage: number) {
  if (atPage < 1) return;
  const c = s.pages[atPage - 1];
  if (!c) return;
  c.status = 'narrate_paused';
}

function applyQuestionInterruptToPage(s: Session, atPage: number) {
  applyPauseToPage(s, atPage);
}

function fsmContext(s: Session): FsmTransitionContext {
  return {
    totalPages: s.presentation.totalPages,
    /** ai-dev-plan 4.8：降级时禁用自动翻页 */
    advanceMode: s.fallbackMode ? 'manual' : s.advanceMode,
    restorePresentingSub: s.resumePresentingSub,
  };
}

type TransOk = Extract<ReturnType<typeof transition>, { ok: true }>;

async function produceAskAnswer(
  s: Session,
  question: string,
  currentPage: number,
): Promise<{
  answerText: string;
  sourcePages: number[];
  confidence: number;
  recoverableInfrastructureFailure: boolean;
  llmAttemptsUsed: number;
}> {
  const total = Math.max(1, s.presentation.totalPages);
  const page = Math.min(Math.max(1, Math.trunc(currentPage)), total);
  const qa = await runQaPipeline({
    pages: s.presentation.pages,
    question,
    currentPage: page,
    kb: s.presentation.kb,
  });
  if (qa.llmUnavailable) {
    s.fallbackMode = true;
  }
  if (qa.llmUnavailable && qa.llmAttemptsUsed >= 2) {
    await appendSessionAudit(s.id, {
      type: 'llm_retry_summary',
      attemptsUsed: qa.llmAttemptsUsed,
      recoverableInfrastructureFailure: qa.recoverableInfrastructureFailure,
    });
  }
  if (qa.recoverableInfrastructureFailure) {
    await appendSessionAudit(s.id, {
      type: 'error_recoverable',
      source: 'llm',
      questionPreview: question.slice(0, 240),
      llmAttemptsUsed: qa.llmAttemptsUsed,
      reason: 'timeout_or_5xx_exhausted',
    });
  } else if (qa.llmUnavailable) {
    await appendSessionAudit(s.id, {
      type: 'qa_llm_degraded',
      questionPreview: question.slice(0, 240),
      llmAttemptsUsed: qa.llmAttemptsUsed,
    });
  }
  const sourcePages =
    qa.sourcePages.length > 0 ? qa.sourcePages : [Math.min(Math.max(1, s.fsm.currentPage), total)];
  return {
    answerText: qa.answerText,
    sourcePages,
    confidence: qa.confidence,
    recoverableInfrastructureFailure: qa.recoverableInfrastructureFailure,
    llmAttemptsUsed: qa.llmAttemptsUsed,
  };
}

async function appendPageQa(
  s: Session,
  question: string,
  answer: string,
  sourcePages: number[],
): Promise<void> {
  const p = s.fsm.currentPage;
  if (p < 1) return;
  const cell = s.pages[p - 1];
  if (!cell) return;
  cell.qaHistory.push({
    question,
    answer,
    sourcePages,
    timestamp: nowIso(),
  });
  await appendSessionAudit(s.id, {
    type: 'qa_round',
    pageNo: p,
    questionPreview: question.slice(0, 400),
    answerPreview: answer.slice(0, 500),
    sourcePages,
  });
}

async function completeAskRound(
  s: Session,
  q0: string,
  ans: {
    answerText: string;
    sourcePages: number[];
    confidence: number;
    recoverableInfrastructureFailure: boolean;
    llmAttemptsUsed: number;
  },
  qaDoneErrorLabel: string,
): Promise<AskResult | { error: string; code: string }> {
  await appendPageQa(s, q0, ans.answerText, ans.sourcePages);
  if (ans.recoverableInfrastructureFailure) {
    await appendSessionAudit(s.id, {
      type: 'qa_round_outcome',
      outcome: 'recoverable_interrupted',
      llmAttemptsUsed: ans.llmAttemptsUsed,
    });
    const r = runOneTransition(s, { type: 'ERROR_RECOVERABLE', source: 'llm' }, undefined);
    if (!r.ok) {
      return { error: r.message ?? '无法进入中断态。', code: 'FSM' };
    }
    return {
      answerText: ans.answerText,
      sourcePages: ans.sourcePages,
      confidence: ans.confidence,
      fallbackMode: s.fallbackMode,
      state: r.state,
      currentPage: s.fsm.currentPage,
    };
  }
  const r = runOneTransition(s, { type: 'QA_DONE' }, undefined);
  if (!r.ok) {
    return { error: r.message ?? qaDoneErrorLabel, code: 'FSM' };
  }
  return {
    answerText: ans.answerText,
    sourcePages: ans.sourcePages,
    confidence: ans.confidence,
    fallbackMode: s.fallbackMode,
    state: r.state,
    currentPage: s.fsm.currentPage,
  };
}

function runOneTransition(
  s: Session,
  ev: FsmEvent,
  eventId: string | undefined,
  logChannel?: string,
): ControlResult {
  const from = s.fsm;
  const t = transition(from, ev, fsmContext(s));
  if (!t.ok) {
    logFsm(s, from, from, ev, eventId, {
      result: 'rejected',
      error: t.error,
      channel: logChannel,
    });
    s.lastError = t.error;
    s.updatedAt = nowIso();
    return {
      ok: false,
      currentPage: s.fsm.currentPage,
      state: compositeStateString(s.fsm),
      message: t.error,
    };
  }
  return applySuccessTransition(s, from, t, ev, eventId);
}

function applySuccessTransition(
  s: Session,
  from: FsmState,
  t: TransOk,
  logEvent: FsmEvent,
  eventId: string | undefined,
): ControlResult {
  const old = from;
  const nxt = t.next;
  const op = t.actions;
  const pageOrEntryChanged = nxt.currentPage !== from.currentPage;

  if (op.includes('pauseSession')) {
    applyPauseToPage(s, from.currentPage);
  }
  if (op.includes('ttsSegmentDone')) {
    markPageNarrated(s, from.currentPage);
  }
  if (op.includes('ttsFailed')) {
    markTtsFailedOnPage(s, from.currentPage);
  }
  if (op.includes('enterQa')) {
    s.resumePresentingSub = from.presentingSub ?? 'narrating';
    applyQuestionInterruptToPage(s, from.currentPage);
  }
  if (pageOrEntryChanged && nxt.currentPage >= 1) {
    if (from.currentPage >= 1) {
      applyDwellOnLeave(s, from.currentPage);
    }
    enterPage(s, nxt.currentPage);
  }
  s.fsm = nxt;
  if (op.includes('errorRecoverableFromPresenting')) {
    s.resumePresentingSub = from.presentingSub ?? 'narrating';
    applyQuestionInterruptToPage(s, from.currentPage);
  }
  if (op.includes('errorRecoverableFromQa') || op.includes('qaFailedToInterrupted')) {
    /* resumePresentingSub 已在 enterQa 时写入 */
  }
  if (op.includes('returnFromQa') || op.includes('resumeFromInterrupted')) {
    s.resumePresentingSub = undefined;
  }
  if (op.includes('resumeSession') || op.includes('returnFromQa') || op.includes('resumeFromInterrupted')) {
    applyResumeToPage(s);
  }
  s.updatedAt = nowIso();
  s.lastError = undefined;
  logFsm(s, old, nxt, logEvent, eventId, { actions: op, notice: t.notice });
  return {
    ok: true,
    currentPage: s.fsm.currentPage,
    state: compositeStateString(s.fsm),
    message: t.notice,
  };
}

function toControlRequest(
  action: import('../domain/intent-parser.js').CommandAction,
  page?: number,
): ControlRequest {
  if (action === 'goto') {
    const p = page === undefined || !Number.isFinite(page) ? 1 : Math.trunc(page);
    return { action: 'goto', page: p };
  }
  return { action: action as ControlRequest['action'] };
}

function mapActionToEvent(req: ControlRequest): { ok: true; event: FsmEvent } | { ok: false; error: string } {
  const { action, page } = req;
  if (action === 'start') return { ok: true, event: { type: 'START' } };
  if (action === 'stop') return { ok: true, event: { type: 'STOP' } };
  if (action === 'next') return { ok: true, event: { type: 'NEXT' } };
  if (action === 'prev') return { ok: true, event: { type: 'PREV' } };
  if (action === 'pause') return { ok: true, event: { type: 'PAUSE' } };
  if (action === 'resume') return { ok: true, event: { type: 'RESUME' } };
  if (action === 'goto') {
    if (page === undefined || !Number.isFinite(page)) {
      return { ok: false, error: 'goto 需要正整数 page。' };
    }
    return { ok: true, event: { type: 'GOTO', page: Math.trunc(page) } };
  }
  return { ok: false, error: 'unknown action' };
}

export const sessionService = {
  hasSession(sid: string): boolean {
    return sessions.has(sid);
  },

  startSession(presentationId: string): StartSessionResult {
    const p = getPresentation(presentationId);
    const id = randomUUID();
    const pages = makePageContexts(p);
    const s: Session = {
      id,
      presentation: p,
      pages,
      fsm: { top: 'idle', presentingSub: null, currentPage: 0 },
      advanceMode: config.defaultAdvanceMode,
      fallbackMode: false,
      serverTtsFailureStreak: 0,
      pageEnteredAtMs: Date.now(),
      updatedAt: nowIso(),
      idempotencyOrder: [],
      idempotencyResults: new Map(),
    };
    sessions.set(id, s);
    logger.info('session created', { kind: 'session', sessionId: id, presentationId, totalPages: p.totalPages });
    void appendSessionAudit(id, {
      type: 'session_created',
      presentationId,
      totalPages: p.totalPages,
    });

    // Async: if deckFile exists but no slideImages cache, trigger conversion
    if (p.deckFile && !p.slideImages && config.libreOfficeConvertEnabled) {
      const pptxPath = join(config.presentationsDir, presentationId, p.deckFile);
      const slidesDir = join(config.presentationsDir, presentationId, 'slides');
      void ensureSlidesConverted(pptxPath, slidesDir, p.totalPages)
        .then((result) => {
          if (result.ok) {
            invalidatePresentationCache(presentationId);
          }
        })
        .catch(() => { /* conversion failure already logged inside ensureSlidesConverted */ });
    }

    return { sessionId: id, totalPages: p.totalPages, state: 'idle' };
  },

  control(sid: string, req: ControlRequest): ControlResult {
    const s = sessions.get(sid);
    if (!s) {
      return { ok: false, currentPage: 0, state: 'unknown', message: '会话不存在。' };
    }

    if (req.eventId) {
      const cached = s.idempotencyResults.get(req.eventId);
      if (cached) {
        return cached;
      }
    }

    const evMap = mapActionToEvent(req);
    if (!evMap.ok) {
      const r: ControlResult = {
        ok: false,
        currentPage: s.fsm.currentPage,
        state: compositeStateString(s.fsm),
        message: evMap.error,
      };
      s.lastError = evMap.error;
      s.updatedAt = nowIso();
      void appendSessionAudit(s.id, { type: 'control_validation_error', message: evMap.error });
      if (req.eventId) {
        pushIdempotency(s, req.eventId, r);
      }
      return r;
    }

    const r2 = runOneTransition(s, evMap.event, req.eventId);
    if (req.eventId) {
      pushIdempotency(s, req.eventId, r2);
    }
    return r2;
  },

  narrationNotify(
    sid: string,
    body: { event: 'TTS_DONE' | 'TTS_FAILED' | 'COUNTDOWN_END'; eventId?: string },
  ): ControlResult {
    const s = sessions.get(sid);
    if (!s) {
      return { ok: false, currentPage: 0, state: 'unknown', message: '会话不存在。' };
    }
    if (body.eventId) {
      const cached = s.idempotencyResults.get(body.eventId);
      if (cached) {
        return cached;
      }
    }
    const ev: FsmEvent =
      body.event === 'TTS_DONE'
        ? { type: 'TTS_DONE' }
        : body.event === 'TTS_FAILED'
          ? { type: 'TTS_FAILED' }
          : { type: 'AUTO_COUNTDOWN_END' };
    void appendSessionAudit(s.id, {
      type: 'narration_client_event',
      event: body.event,
      eventId: body.eventId ?? null,
      currentPage: s.fsm.currentPage,
      narrationOutcome:
        body.event === 'TTS_DONE' ? 'tts_success' : body.event === 'TTS_FAILED' ? 'tts_failed' : 'countdown_end',
    });
    const r2 = runOneTransition(s, ev, body.eventId, 'narration');
    if (body.eventId) {
      pushIdempotency(s, body.eventId, r2);
    }
    return r2;
  },

  patchSession(
    sid: string,
    body: { mode?: AdvanceMode; clearFallback?: boolean },
  ): SessionPatchResult | { error: string } {
    const s = sessions.get(sid);
    if (!s) {
      return { error: '会话不存在' };
    }
    const wantsMode = body.mode === 'manual' || body.mode === 'auto';
    const wantsClear = body.clearFallback === true;
    if (!wantsMode && !wantsClear) {
      return { error: '请提供 mode（manual|auto）或 clearFallback: true' };
    }
    const msgs: string[] = [];
    let changed = false;
    if (wantsMode) {
      const m = body.mode;
      if (m === 'manual' || m === 'auto') {
        if (s.advanceMode !== m) {
          s.advanceMode = m;
          changed = true;
          msgs.push(`已切换为 ${m === 'auto' ? '自动' : '手动'}翻页策略。`);
        }
      }
    }
    if (wantsClear) {
      if (s.fallbackMode) {
        s.fallbackMode = false;
        void appendSessionAudit(s.id, { type: 'fallback_cleared' });
        msgs.push('已关闭降级模式。');
        changed = true;
      } else {
        msgs.push('当前未处于降级模式。');
      }
    }
    if (!changed && wantsMode && !wantsClear) {
      return { error: '未修改：翻页策略已与所选 mode 相同' };
    }
    if (!changed && wantsClear && !wantsMode) {
      s.updatedAt = nowIso();
      const eff: AdvanceMode = s.fallbackMode ? 'manual' : s.advanceMode;
      return {
        ok: true,
        currentPage: s.fsm.currentPage,
        state: compositeStateString(s.fsm),
        mode: s.advanceMode,
        fallbackMode: s.fallbackMode,
        advanceModeEffective: eff,
        message: msgs.join(' '),
      };
    }
    if (!changed && wantsMode && wantsClear) {
      return { error: '未修改：翻页策略未变化且未处于降级' };
    }
    s.updatedAt = nowIso();
    const eff: AdvanceMode = s.fallbackMode ? 'manual' : s.advanceMode;
    return {
      ok: true,
      currentPage: s.fsm.currentPage,
      state: compositeStateString(s.fsm),
      mode: s.advanceMode,
      fallbackMode: s.fallbackMode,
      advanceModeEffective: eff,
      message: msgs.join(' '),
    };
  },

  getSession(sid: string): SessionGetResult | null {
    const s = sessions.get(sid);
    if (!s) return null;
    return {
      sessionId: s.id,
      currentPage: s.fsm.currentPage,
      state: compositeStateString(s.fsm),
      subState: s.fsm.presentingSub,
      topState: s.fsm.top,
      mode: s.advanceMode,
      fallbackMode: s.fallbackMode,
      advanceModeEffective: s.fallbackMode ? 'manual' : s.advanceMode,
      updatedAt: s.updatedAt,
      lastError: s.lastError,
      totalPages: s.presentation.totalPages,
      title: s.presentation.title,
      presentationId: s.presentation.presentationId,
      deckFile: s.presentation.deckFile,
      assetBaseUrl: s.presentation.assetBaseUrl,
      slideImagesBaseUrl: s.presentation.slideImagesBaseUrl,
      slideImages: s.presentation.slideImages,
      pages: s.pages.map(toSnapshot),
      pagesData: s.presentation.pages,
      autoCountdownSec: config.autoAdvanceCountdownSec,
      ttsBackend: getTtsBackendHint(),
      narrationTtsEnabled: config.narrationTtsEnabled,
      presentationEditorEnabled: config.presentationEditorEnabled,
    };
  },

  async submitAsk(
    sid: string,
    body: { question: string; currentPage: number },
  ): Promise<AskResult | { error: string; code: string }> {
    const s = sessions.get(sid);
    if (!s) {
      return { error: '会话不存在。', code: 'NOT_FOUND' };
    }
    const q0 = (body.question ?? '').trim();
    if (!q0) {
      return { error: '问题不能为空。', code: 'VALIDATION' };
    }
    if (s.fsm.top === 'end' || s.fsm.top === 'idle' || s.fsm.top === 'interrupted' || s.fsm.top === 'paused') {
      return {
        error: '仅可在讲解/问答中提问；请开始讲解或从暂停/中断中恢复后重试。',
        code: 'BAD_STATE',
      };
    }
    if (s.fsm.top === 'qa') {
      const ans = await produceAskAnswer(s, q0, body.currentPage);
      return await completeAskRound(s, q0, ans, '无法结束问答。');
    }
    if (s.fsm.top === 'presenting') {
      const r1 = runOneTransition(s, { type: 'QUESTION_DETECTED' }, undefined);
      if (!r1.ok) {
        return { error: r1.message ?? '无法进入问答。', code: 'FSM' };
      }
      const ans = await produceAskAnswer(s, q0, body.currentPage);
      return await completeAskRound(s, q0, ans, '无法恢复讲解。');
    }
    return { error: '当前状态不可使用问答。', code: 'BAD_STATE' };
  },

  interpretText(sid: string, transcript: string): InterpretResult {
    const s = sessions.get(sid);
    if (!s) {
      return { kind: 'noop', reason: '会话不存在', transcript };
    }
    const ch = s.presentation.chapters;
    const hasCh = Boolean(ch && ch.length > 0);
    const intent = parseUserIntent(transcript, {
      totalPages: s.presentation.totalPages,
      hasChapters: hasCh,
      chapters: ch?.map((c) => ({ id: c.id, title: c.title, startPage: c.startPage })),
    });
    if (intent.kind === 'noop') {
      return { kind: 'noop', reason: intent.reason, transcript };
    }
    if (intent.kind === 'command') {
      const reqC = toControlRequest(intent.action, intent.page);
      return { kind: 'control', result: sessionService.control(sid, reqC), transcript };
    }
    return {
      kind: 'ask_suggestion',
      text: intent.text,
      transcript,
      message: '识别为自然语言问题；在讲解中可提交为问答（检索 + LLM，失败时按 2.1D 降级）。',
    };
  },

  /**
   * 语音/文本管线（与 ai-dev-plan 1.1.4 对齐）：
   * 1) 命中正则短命令 → 直接执行（control）；
   * 2) 否则调用 LLM 意图分类器（intent-classify）：
   *    - question + 可作答态 → 走 submitAsk（answered）
   *    - irrelevant → ignored，前端不打断 TTS
   *    - 不在可作答态（idle/end/paused/...）→ suggest_ask 提示
   */
  async processVoiceText(sid: string, transcript: string): Promise<VoicePipelineResult> {
    const s = sessions.get(sid);
    if (!s) {
      return { kind: 'rejected', message: '会话不存在。', transcript, code: 'NOT_FOUND' };
    }
    const it = sessionService.interpretText(sid, transcript);
    if (it.kind === 'control') {
      return { kind: 'control', transcript, result: it.result };
    }

    // Echo 自激过滤：仅在 TTS 实际可能在出声的态（presenting.narrating）下检查。
    // transcript 与"当前页讲稿"重叠率过高 → 判定为扬声器回授到麦克风的回声，丢弃不打断。
    const ttsLikelyPlaying =
      s.fsm.top === 'presenting' && s.fsm.presentingSub === 'narrating';
    if (ttsLikelyPlaying) {
      const currentScript = s.presentation.pages.find((p) => p.pageNo === s.fsm.currentPage)?.script ?? '';
      if (currentScript) {
        const echo = checkEchoOverlap(transcript, currentScript);
        if (echo.isEcho) {
          void appendSessionAudit(sid, {
            type: 'voice_echo_dropped',
            transcript: transcript.slice(0, 200),
            ratio: Number(echo.ratio.toFixed(2)),
            threshold: echo.threshold,
          });
          return {
            kind: 'ignored',
            transcript,
            reason: `疑似 TTS 回授（与讲稿重叠 ${(echo.ratio * 100).toFixed(0)}%）`,
            classifierFallback: true,
          };
        }
      }
    }

    const askable = s.fsm.top === 'presenting' || s.fsm.top === 'qa';

    // ask_suggestion 与 noop（非命令）都走"LLM 意图分类"再决定是否打断
    const cls = await classifyTranscriptIntent({
      transcript,
      currentPage: s.fsm.currentPage,
      pages: s.presentation.pages,
    });
    void appendSessionAudit(sid, {
      type: 'voice_intent_classified',
      transcript: transcript.slice(0, 200),
      intent: cls.intent,
      reason: cls.reason,
      classifierFallback: cls.fallbackUsed,
    });

    if (cls.intent === 'question') {
      if (!askable) {
        return {
          kind: 'suggest_ask',
          transcript,
          text: transcript,
          message: '当前状态不可问答，请在讲解或问答中提交。',
        };
      }
      const askText =
        it.kind === 'ask_suggestion' ? it.text : transcript;
      const a = await sessionService.submitAsk(sid, {
        question: askText,
        currentPage: s.fsm.currentPage,
      });
      if ('error' in a) {
        return {
          kind: 'rejected',
          message: a.error,
          transcript,
          code: a.code,
        };
      }
      return { kind: 'answered', transcript, ask: a };
    }

    // irrelevant：不打断 TTS，仅留痕
    return {
      kind: 'ignored',
      transcript,
      reason: cls.reason,
      classifierFallback: cls.fallbackUsed,
    };
  },

  /**
   * 外层 ASR 等失败时调用：在讲解/问答态进入 interrupted + fallback（4.8）。
   */
  notifyRecoverableFailure(
    sid: string,
    input: { source: 'asr' | 'tts'; messagePreview?: string },
  ): { ok: boolean; transitioned: boolean } {
    const s = sessions.get(sid);
    if (!s) return { ok: false, transitioned: false };
    if (s.fsm.top !== 'presenting' && s.fsm.top !== 'qa') {
      void appendSessionAudit(sid, {
        type: 'error_recoverable_skipped',
        source: input.source,
        fsmTop: s.fsm.top,
        preview: input.messagePreview?.slice(0, 200) ?? null,
      });
      return { ok: true, transitioned: false };
    }
    s.fallbackMode = true;
    void appendSessionAudit(sid, {
      type: 'error_recoverable',
      source: input.source,
      preview: input.messagePreview?.slice(0, 240) ?? null,
    });
    const r = runOneTransition(s, { type: 'ERROR_RECOVERABLE', source: input.source }, undefined);
    return { ok: true, transitioned: r.ok };
  },

  /** 服务端 /tts-audio 失败时累加；连续 2 次触发 4.8 可恢复中断 */
  recordServerTtsFailure(sid: string, messagePreview: string): void {
    const s = sessions.get(sid);
    if (!s) return;
    s.serverTtsFailureStreak += 1;
    void appendSessionAudit(sid, {
      type: 'tts_server_failure',
      streak: s.serverTtsFailureStreak,
      preview: messagePreview.slice(0, 220),
    });
    if (s.serverTtsFailureStreak < 2) return;
    if (s.fsm.top !== 'presenting' && s.fsm.top !== 'qa') return;
    s.fallbackMode = true;
    void appendSessionAudit(sid, {
      type: 'error_recoverable',
      source: 'tts',
      reason: 'consecutive_server_tts_failures',
      preview: messagePreview.slice(0, 220),
    });
    runOneTransition(s, { type: 'ERROR_RECOVERABLE', source: 'tts' }, undefined);
  },

  recordServerTtsSuccess(sid: string): void {
    const s = sessions.get(sid);
    if (!s) return;
    if (s.serverTtsFailureStreak > 0) {
      void appendSessionAudit(sid, { type: 'tts_server_failure_reset', priorStreak: s.serverTtsFailureStreak });
    }
    s.serverTtsFailureStreak = 0;
  },
}
