import type { FsmState, FsmEvent, PresentingSub } from '../types/session.js';
import type { FsmTransitionContext } from './fsm-options.js';

export function compositeStateString(s: FsmState): string {
  if (s.top === 'presenting' && s.presentingSub) {
    return `presenting.${s.presentingSub}`;
  }
  return s.top;
}

/**
 * 纯函数：不处理幂等；由 SessionService 在应用前对 eventId 去重。
 * advanceMode: auto 时 TTS_DONE 进入 auto_advance；否则进入 waiting_confirm。
 */
export function transition(
  s: FsmState,
  event: FsmEvent,
  options: FsmTransitionContext,
):
  | { ok: true; next: FsmState; actions: string[]; notice?: string }
  | { ok: false; error: string; same: FsmState; actions: string[] } {
  if (s.top === 'end') {
    return { ok: false, same: s, error: '会话已结束，无法接受控制。', actions: [] };
  }

  const { totalPages, advanceMode, restorePresentingSub } = options;

  const clamp = (n: number) => Math.min(Math.max(1, n), Math.max(1, totalPages));

  const ensurePresentingOrPausedForPageNav = (): { ok: true } | { ok: false; msg: string } => {
    if (s.top === 'presenting' || s.top === 'paused') return { ok: true };
    if (s.top === 'idle') {
      return { ok: false, msg: '空闲态下无法翻页，请先 start。' };
    }
    if (s.top === 'qa' || s.top === 'interrupted') {
      return { ok: false, msg: '问答/中断中无法翻页，先完成或恢复讲解。' };
    }
    return { ok: false, msg: '无法翻页。' };
  };

  switch (event.type) {
    case 'START': {
      if (s.top !== 'idle') {
        return { ok: false, same: s, error: '仅 idle 可开始。', actions: [] };
      }
      return {
        ok: true,
        next: {
          top: 'presenting',
          presentingSub: 'narrating',
          currentPage: 1,
        },
        actions: ['enterPage'],
      };
    }
    case 'STOP': {
      if (
        s.top === 'idle' ||
        s.top === 'presenting' ||
        s.top === 'paused' ||
        s.top === 'qa' ||
        s.top === 'interrupted'
      ) {
        return { ok: true, next: { top: 'end', presentingSub: null, currentPage: s.currentPage }, actions: ['endSession'] };
      }
      return { ok: false, same: s, error: '无法结束。', actions: [] };
    }
    case 'PAUSE': {
      if (s.top !== 'presenting') {
        return { ok: false, same: s, error: '仅讲解中可暂停。', actions: [] };
      }
      return {
        ok: true,
        next: { top: 'paused', presentingSub: s.presentingSub, currentPage: s.currentPage },
        actions: ['pauseSession'],
      };
    }
    case 'RESUME': {
      if (s.top === 'paused') {
        if (!s.presentingSub) {
          return { ok: false, same: s, error: '未记录讲解子态，无法恢复。', actions: [] };
        }
        return {
          ok: true,
          next: { top: 'presenting', presentingSub: s.presentingSub, currentPage: s.currentPage },
          actions: ['resumeSession'],
        };
      }
      if (s.top === 'interrupted') {
        const subR = restorePresentingSub;
        if (!subR) {
          return { ok: false, same: s, error: '无恢复子态。', actions: [] };
        }
        return {
          ok: true,
          next: { top: 'presenting', presentingSub: subR, currentPage: s.currentPage },
          actions: ['resumeFromInterrupted'],
        };
      }
      return { ok: false, same: s, error: '仅暂停或中断态可继续。', actions: [] };
    }
    case 'NEXT': {
      const g = ensurePresentingOrPausedForPageNav();
      if (!g.ok) {
        return { ok: false, same: s, error: g.msg, actions: [] };
      }
      if (s.top === 'presenting' && s.presentingSub === 'auto_advance') {
        return { ok: false, same: s, error: '自动翻页倒计时中请等待完成或使用 pause。', actions: [] };
      }
      if (s.currentPage >= totalPages) {
        return { ok: true, next: s, actions: [], notice: '已在最后一页。' };
      }
      const newPage = s.currentPage + 1;
      return {
        ok: true,
        next: {
          top: s.top,
          presentingSub: 'narrating',
          currentPage: newPage,
        },
        actions: ['turnPageNext'],
      };
    }
    case 'PREV': {
      const g2 = ensurePresentingOrPausedForPageNav();
      if (!g2.ok) {
        return { ok: false, same: s, error: g2.msg, actions: [] };
      }
      if (s.currentPage <= 1) {
        return { ok: true, next: s, actions: [], notice: '已在第一页。' };
      }
      const newPageP = s.currentPage - 1;
      return {
        ok: true,
        next: { top: s.top, presentingSub: 'narrating', currentPage: newPageP },
        actions: ['turnPagePrev'],
      };
    }
    case 'GOTO': {
      const g3 = ensurePresentingOrPausedForPageNav();
      if (!g3.ok) {
        return { ok: false, same: s, error: g3.msg, actions: [] };
      }
      if (s.top === 'presenting' && s.presentingSub === 'auto_advance') {
        return { ok: false, same: s, error: '自动翻页模式下暂不支持跳转。', actions: [] };
      }
      const target = clamp(event.page);
      return {
        ok: true,
        next: { top: s.top, presentingSub: 'narrating', currentPage: target },
        actions: ['turnPageGoto'],
      };
    }
    case 'TTS_DONE': {
      if (s.top !== 'presenting' || s.presentingSub !== 'narrating') {
        return { ok: false, same: s, error: '仅讲解·播报中可接收 TTS 完成。', actions: [] };
      }
      const sub: PresentingSub = advanceMode === 'auto' ? 'auto_advance' : 'waiting_confirm';
      return {
        ok: true,
        next: { ...s, presentingSub: sub },
        actions: ['ttsSegmentDone'],
      };
    }
    case 'TTS_FAILED': {
      if (s.top !== 'presenting' || s.presentingSub !== 'narrating') {
        return { ok: false, same: s, error: '仅讲解·播报中可报告 TTS 失败。', actions: [] };
      }
      return {
        ok: true,
        next: { ...s, presentingSub: 'waiting_confirm' },
        actions: ['ttsFailed'],
      };
    }
    case 'AUTO_COUNTDOWN_END': {
      if (s.top !== 'presenting' || s.presentingSub !== 'auto_advance') {
        return { ok: false, same: s, error: '仅 auto_advance 可触发倒计时结束。', actions: [] };
      }
      if (s.currentPage >= totalPages) {
        return {
          ok: true,
          next: { top: 'end', presentingSub: null, currentPage: s.currentPage },
          actions: ['endSession'],
          notice: '最后一页讲解完成，会话自动结束。',
        };
      }
      return {
        ok: true,
        next: {
          top: 'presenting',
          presentingSub: 'narrating',
          currentPage: s.currentPage + 1,
        },
        actions: ['turnPageNext', 'fromAutoCountdown'],
      };
    }
    case 'QUESTION_DETECTED': {
      if (s.top !== 'presenting') {
        return { ok: false, same: s, error: '仅讲解中可进入问答。', actions: [] };
      }
      return {
        ok: true,
        next: { top: 'qa', presentingSub: null, currentPage: s.currentPage },
        actions: ['enterQa'],
      };
    }
    case 'QA_DONE': {
      if (s.top !== 'qa') {
        return { ok: false, same: s, error: '仅问答中可完成。', actions: [] };
      }
      const subQ: PresentingSub = restorePresentingSub ?? 'narrating';
      return {
        ok: true,
        next: { top: 'presenting', presentingSub: subQ, currentPage: s.currentPage },
        actions: ['returnFromQa'],
      };
    }
    case 'QA_FAILED': {
      if (s.top !== 'qa') {
        return { ok: false, same: s, error: '仅问答中可标记失败。', actions: [] };
      }
      return {
        ok: true,
        next: { top: 'interrupted', presentingSub: null, currentPage: s.currentPage },
        actions: ['qaFailedToInterrupted'],
      };
    }
    case 'ERROR_RECOVERABLE': {
      if (s.top === 'presenting') {
        return {
          ok: true,
          next: { top: 'interrupted', presentingSub: null, currentPage: s.currentPage },
          actions: ['errorRecoverableFromPresenting'],
        };
      }
      if (s.top === 'qa') {
        return {
          ok: true,
          next: { top: 'interrupted', presentingSub: null, currentPage: s.currentPage },
          actions: ['errorRecoverableFromQa'],
        };
      }
      return {
        ok: false,
        same: s,
        error: '仅讲解或问答中可进入可恢复错误态（interrupted）。',
        actions: [],
      };
    }
    default: {
      const _ex: never = event;
      return { ok: false, same: s, error: `未知事件：${String(_ex)}`, actions: [] };
    }
  }
}
