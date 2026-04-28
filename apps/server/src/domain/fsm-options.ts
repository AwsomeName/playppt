import type { AdvanceMode, PresentingSub } from '../types/session.js';

/** FSM 纯转移所需、由 Session 注入的元数据 */
export type FsmTransitionContext = {
  totalPages: number;
  advanceMode: AdvanceMode;
  /** 从 qa/ interrupted 恢复讲解时注入 */
  restorePresentingSub?: PresentingSub;
};
