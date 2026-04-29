export type TopState = 'idle' | 'presenting' | 'paused' | 'qa' | 'interrupted' | 'end';
export type PresentingSub = 'narrating' | 'waiting_confirm' | 'auto_advance' | 'opening_narrating' | 'closing_narrating';
export type AdvanceMode = 'manual' | 'auto';
export type PageStatus =
  | 'unvisited'
  | 'narrating'
  | 'narrate_paused'
  | 'narrated'
  | 'skipped';

export interface PageQARecord {
  question: string;
  answer: string;
  sourcePages: number[];
  timestamp: string;
}

export interface PageContext {
  pageNo: number;
  status: PageStatus;
  narrationProgress: {
    totalChars: number;
    playedChars: number;
    playedDurationMs: number;
    totalDurationMs: number;
  };
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  dwellMs: number;
  qaHistory: PageQARecord[];
}

export interface FsmState {
  top: TopState;
  /** Meaningful when top is presenting, or the resume target when top is paused */
  presentingSub: PresentingSub | null;
  currentPage: number;
}

export type FsmEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'NEXT' }
  | { type: 'PREV' }
  | { type: 'GOTO'; page: number }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'TTS_DONE' }
  | { type: 'TTS_FAILED' }
  | { type: 'AUTO_COUNTDOWN_END' }
  | { type: 'QUESTION_DETECTED' }
  | { type: 'QA_DONE' }
  | { type: 'QA_FAILED' }
  /** 4.8：ASR/LLM/TTS 超时或连续 5xx 等可恢复故障 -> interrupted + fallbackMode（由 SessionService 置位） */
  | { type: 'ERROR_RECOVERABLE'; source?: 'asr' | 'llm' | 'tts' }
