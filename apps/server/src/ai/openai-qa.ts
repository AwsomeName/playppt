import type { RetrievedChunk } from './page-retrieval.js';

export type QaJsonShape = {
  answerText: string;
  sourcePages: number[];
  confidence: number;
  cannotConfirm?: boolean;
};

/** 从模型输出中尽量解析 JSON（支持 ```json 围栏）。 */
export function parseLlmQaJson(content: string): QaJsonShape | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const answerText = typeof j.answerText === 'string' ? j.answerText.trim() : '';
    const confRaw = j.confidence;
    const confidence =
      typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? Math.min(1, Math.max(0, confRaw))
        : 0.5;
    const sp = j.sourcePages;
    const sourcePages = Array.isArray(sp)
      ? sp
          .map((x) => (typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : NaN))
          .filter((x) => Number.isInteger(x) && x >= 0)
      : [];
    const cannotConfirm = j.cannotConfirm === true;
    if (!answerText) return null;
    return { answerText, sourcePages, confidence, cannotConfirm };
  } catch {
    return null;
  }
}

export function clampSourcePages(sourcePages: number[], allowed: Set<number>): number[] {
  const out: number[] = [];
  for (const p of sourcePages) {
    if (allowed.has(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

export function mockAnswerFromRetrieval(
  question: string,
  chunks: RetrievedChunk[],
): QaJsonShape {
  if (chunks.length === 0) {
    return {
      answerText: '演示数据中没有可用的页面摘录，无法根据幻灯片回答该问题。',
      sourcePages: [],
      confidence: 0,
      cannotConfirm: true,
    };
  }
  const top = chunks[0]!;
  const flat = top.text.replace(/\s+/g, ' ').trim();
  const snippet = flat.slice(0, 320);
  const where = top.pageNo === 0 ? '知识库摘录' : `第 ${top.pageNo} 页摘录`;
  return {
    answerText: `（降级）根据检索到的${where}，与问题「${question.slice(0, 80)}${question.length > 80 ? '…' : ''}」可能相关的原文如下，请自行核对：「${snippet}${flat.length > 320 ? '…' : ''}」`,
    sourcePages: [top.pageNo],
    confidence: 0.32,
    cannotConfirm: true,
  };
}

const QA_SYSTEM = `你是演示文稿问答助手。用户会提供若干摘录：幻灯片页来自 title、content、script 拼块；知识库条目单独标注。
规则：
1) 仅根据摘录作答；若摘录不足以支持结论，必须明确说明无法从材料中确认，不要编造事实。
2) 回答使用简体中文，简洁有条理。
3) 必须输出一个 JSON 对象（不要其它说明文字），字段：
   - answerText: string
   - sourcePages: number[] 支持你结论的页码；幻灯片页为 1..N；若结论仅来自知识库且无对应幻灯片页，使用 [0]
   - confidence: number 0 到 1
   - cannotConfirm: boolean 若信息不足则为 true`;

function formatUserPayload(question: string, chunks: RetrievedChunk[]): string {
  const blocks = chunks
    .map((c) =>
      c.pageNo === 0 ? `### 知识库\n${c.text}` : `### 第 ${c.pageNo} 页\n${c.text}`,
    )
    .join('\n\n');
  return `用户问题：\n${question}\n\n--- 摘录 ---\n${blocks}`;
}

async function chatOnce(
  apiKey: string,
  model: string,
  userPayload: string,
  signal: AbortSignal,
): Promise<{ ok: true; content: string } | { ok: false; status: number; body: string }> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: QA_SYSTEM },
        { role: 'user', content: userPayload },
      ],
    }),
    signal,
  });
  const bodyText = await r.text();
  if (!r.ok) {
    return { ok: false, status: r.status, body: bodyText.slice(0, 500) };
  }
  try {
    const j = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = j.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) return { ok: false, status: r.status, body: 'empty choices' };
    return { ok: true, content };
  } catch {
    return { ok: false, status: r.status, body: bodyText.slice(0, 300) };
  }
}

function shouldRetry(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * OpenAI Chat Completions：单次请求 15s 超时；仅对 5xx 再试最多 2 次（与 ai-dev-plan 2.1D 对齐）。
 * 超时或非 5xx 错误不叠加多次等待。
 */
export async function completeQaJson(input: {
  apiKey: string;
  model: string;
  question: string;
  chunks: RetrievedChunk[];
  timeoutMs: number;
}): Promise<
  | { ok: true; parsed: QaJsonShape; attemptsUsed: number }
  | {
      ok: false;
      reason: 'http' | 'timeout' | 'parse';
      detail?: string;
      status?: number;
      /** 已发起的 HTTP 轮次数（含超时前中断的一次） */
      attemptsUsed: number;
    }
> {
  const userPayload = formatUserPayload(input.question, input.chunks);
  const maxAttempts = 3;
  let lastHttp: { status: number; body: string } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.timeoutMs);
    try {
      const one = await chatOnce(input.apiKey, input.model, userPayload, ctrl.signal);
      clearTimeout(timer);
      if (one.ok) {
        const parsed = parseLlmQaJson(one.content);
        if (parsed) return { ok: true, parsed, attemptsUsed: attempt + 1 };
        return { ok: false, reason: 'parse', detail: one.content.slice(0, 200), attemptsUsed: attempt + 1 };
      }
      lastHttp = { status: one.status, body: one.body };
      if (!shouldRetry(one.status) || attempt === maxAttempts - 1) {
        return {
          ok: false,
          reason: 'http',
          detail: one.body,
          status: one.status,
          attemptsUsed: attempt + 1,
        };
      }
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && (e.name === 'AbortError' || ctrl.signal.aborted);
      if (aborted) {
        return { ok: false, reason: 'timeout', detail: `${input.timeoutMs}ms`, attemptsUsed: attempt + 1 };
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === maxAttempts - 1) {
        return { ok: false, reason: 'http', detail: msg, attemptsUsed: attempt + 1 };
      }
    }
  }
  return {
    ok: false,
    reason: 'http',
    detail: lastHttp?.body ?? 'unknown',
    status: lastHttp?.status,
    attemptsUsed: maxAttempts,
  };
}
