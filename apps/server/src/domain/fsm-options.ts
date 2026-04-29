import type { AdvanceMode, PresentingSub } from '../types/session.js';

/** FSM 纯转移所需、由 Session 注入的元数据 */
export type FsmTransitionContext = {
  totalPages: number;
  advanceMode: AdvanceMode;
  /** 从 qa/ interrupted 恢复讲解时注入 */
  restorePresentingSub?: PresentingSub;
  /** 是否有开场白（START 后先播报 opening 再进入第1页） */
  hasOpening: boolean;
  /** 是否有收尾（最后页之后播报 closing 再结束） */
  hasClosing: boolean;
};
