const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface StartSessionResponse {
  sessionId: string;
  totalPages: number;
  state: 'idle';
}

export interface ControlResponse {
  ok: boolean;
  currentPage: number;
  state: string;
  message?: string;
}

export type SessionPayload = {
  sessionId: string;
  currentPage: number;
  state: string;
  subState: string | null;
  topState: string;
  mode: 'manual' | 'auto';
  fallbackMode: boolean;
  /** M5：降级时 FSM 按 manual 处理自动翻页 */
  advanceModeEffective?: 'manual' | 'auto';
  updatedAt: string;
  lastError?: string;
  totalPages: number;
  title: string;
  presentationId: string;
  deckFile?: string;
  assetBaseUrl?: string;
  slideImagesBaseUrl?: string;
  slideImages?: Array<{ pageNo: number; file: string; width?: number; height?: number }>;
  slideImagesBaseUrl?: string;
  slideImages?: Array<{ pageNo: number; file: string; width?: number; height?: number }>;
  presentationEditorEnabled?: boolean;
  autoCountdownSec?: number;
  ttsBackend?: 'client' | 'volc' | 'openai' | 'disabled';
  narrationTtsEnabled?: boolean;
  pages: Array<{
    pageNo: number;
    status: string;
    narrationProgress: unknown;
    dwellMs: number;
    qaCount: number;
  }>;
  pagesData: Array<{
    pageNo: number;
    title: string;
    content: string;
    script: string;
  }>;
};

export type PresentationScriptsPayload = {
  scripts: Array<{ pageNo: number; script: string }>;
};

export type PresentationKbPayload = {
  chunks: Array<{ id: string; title: string; body: string }>;
};

export async function apiGetPresentationScripts(
  presentationId: string,
): Promise<PresentationScriptsPayload> {
  const r = await fetch(`/api/presentations/${encodeURIComponent(presentationId)}/scripts`);
  if (!r.ok) {
    const t = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(t.error ?? r.statusText);
  }
  return (await r.json()) as PresentationScriptsPayload;
}

export async function apiPutPresentationScripts(
  presentationId: string,
  body: PresentationScriptsPayload,
): Promise<{ ok: boolean; hint?: string }> {
  const r = await fetch(`/api/presentations/${encodeURIComponent(presentationId)}/scripts`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; hint?: string; error?: string };
  if (!r.ok) {
    throw new Error(data.error ?? r.statusText);
  }
  return { ok: Boolean(data.ok), hint: data.hint };
}

export async function apiGetPresentationKb(presentationId: string): Promise<PresentationKbPayload> {
  const r = await fetch(`/api/presentations/${encodeURIComponent(presentationId)}/kb`);
  if (!r.ok) {
    const t = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(t.error ?? r.statusText);
  }
  return (await r.json()) as PresentationKbPayload;
}

export async function apiPutPresentationKb(
  presentationId: string,
  body: PresentationKbPayload,
): Promise<{ ok: boolean; hint?: string }> {
  const r = await fetch(`/api/presentations/${encodeURIComponent(presentationId)}/kb`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; hint?: string; error?: string };
  if (!r.ok) {
    throw new Error(data.error ?? r.statusText);
  }
  return { ok: Boolean(data.ok), hint: data.hint };
}

export async function apiStartSession(presentationId: string): Promise<StartSessionResponse> {
  const r = await fetch('/api/session/start', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ presentationId }),
  });
  if (!r.ok) {
    const t = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(t.error ?? r.statusText);
  }
  return (await r.json()) as StartSessionResponse;
}

export async function apiPostControl(body: {
  sessionId: string;
  action: 'start' | 'next' | 'prev' | 'goto' | 'pause' | 'resume' | 'stop';
  page?: number;
}): Promise<ControlResponse> {
  const r = await fetch('/api/control', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as ControlResponse & { error?: string; message?: string };
  if (!r.ok) {
    throw new Error(data.message ?? data.error ?? r.statusText);
  }
  return data;
}

export async function apiGetSession(id: string): Promise<SessionPayload> {
  const r = await fetch(`/api/session/${id}`);
  if (r.status === 404) {
    throw new Error('会话不存在或已清理');
  }
  if (!r.ok) {
    const t = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(t.error ?? r.statusText);
  }
  return (await r.json()) as SessionPayload;
}

export async function apiNarrationEvent(
  sessionId: string,
  event: 'TTS_DONE' | 'TTS_FAILED' | 'COUNTDOWN_END',
): Promise<ControlResponse> {
  const r = await fetch(`/api/session/${encodeURIComponent(sessionId)}/narration`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ event }),
  });
  const data = (await r.json().catch(() => ({}))) as ControlResponse & { error?: string; message?: string };
  if (!r.ok) {
    throw new Error(data.message ?? data.error ?? r.statusText);
  }
  return data;
}

export type SessionPatchResponse = {
  ok: boolean;
  currentPage: number;
  state: string;
  mode: 'manual' | 'auto';
  fallbackMode: boolean;
  advanceModeEffective: 'manual' | 'auto';
  message?: string;
};

export async function apiPatchSession(
  sessionId: string,
  body: { mode?: 'manual' | 'auto'; clearFallback?: boolean },
): Promise<SessionPatchResponse> {
  const r = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as SessionPatchResponse & { error?: string };
  if (!r.ok) {
    throw new Error(data.message ?? data.error ?? r.statusText);
  }
  return data as SessionPatchResponse;
}

export async function apiPatchMode(sessionId: string, mode: 'manual' | 'auto'): Promise<SessionPatchResponse> {
  return apiPatchSession(sessionId, { mode });
}

export type InterpretApiResult =
  | { kind: 'control'; result: ControlResponse; transcript: string }
  | { kind: 'ask_suggestion'; text: string; transcript: string; message: string }
  | { kind: 'noop'; reason: string; transcript: string };

export type VoicePipelineResult =
  | { kind: 'control'; transcript: string; result: ControlResponse }
  | {
      kind: 'answered';
      transcript: string;
      ask: {
        answerText: string;
        sourcePages: number[];
        confidence: number;
        fallbackMode: boolean;
        state: string;
        currentPage: number;
      };
    }
  | { kind: 'suggest_ask'; transcript: string; text: string; message: string }
  | { kind: 'rejected'; transcript: string; message: string; code?: string };

export type AskResponse = {
  answerText: string;
  sourcePages: number[];
  confidence: number;
  fallbackMode: boolean;
  state: string;
  currentPage: number;
};

export async function apiPostInterpret(sessionId: string, text: string): Promise<InterpretApiResult> {
  const r = await fetch('/api/interpret', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, text }),
  });
  const data = (await r.json().catch(() => ({}))) as InterpretApiResult & { error?: string };
  if (!r.ok) {
    throw new Error(data.error ?? r.statusText);
  }
  return data as InterpretApiResult;
}

export async function apiPostAsk(
  sessionId: string,
  body: { question: string; currentPage: number },
): Promise<AskResponse> {
  const r = await fetch('/api/ask', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, ...body }),
  });
  const data = (await r.json().catch(() => ({}))) as AskResponse & { error?: string; code?: string };
  if (!r.ok) {
    throw new Error(data.error ?? r.statusText);
  }
  return data as AskResponse;
}

/** 与录音上传后相同的意图管线（不经过 ASR）。 */
export async function apiPostVoiceTextPipeline(sessionId: string, text: string): Promise<VoicePipelineResult> {
  const r = await fetch('/api/voice/text', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, text }),
  });
  const data = (await r.json().catch(() => ({}))) as VoicePipelineResult & { error?: string };
  if (!r.ok) {
    throw new Error((data as { message?: string }).message ?? data.error ?? r.statusText);
  }
  return data as VoicePipelineResult;
}

export type UtteranceOk = { transcript: string; result: VoicePipelineResult };

export async function apiPostVoiceUtterance(sessionId: string, blob: Blob, filename = 'rec.webm'): Promise<UtteranceOk> {
  const fd = new FormData();
  fd.set('sessionId', sessionId);
  fd.set('audio', blob, filename);
  const r = await fetch('/api/voice/utterance', { method: 'POST', body: fd });
  const data = (await r.json().catch(() => ({}))) as UtteranceOk & { error?: string; result?: VoicePipelineResult };
  if (!r.ok) {
    throw new Error((data as { error?: string }).error ?? r.statusText);
  }
  return { transcript: data.transcript, result: data.result as VoicePipelineResult };
}
