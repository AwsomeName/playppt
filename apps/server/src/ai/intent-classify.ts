import { config } from '../config.js';
import type { DemoPage } from '../types/presentation.js';

export type IntentClass = 'question' | 'irrelevant';

export interface ClassifyResult {
  intent: IntentClass;
  reason: string;
  /** true：使用了启发式（无 LLM key 或 LLM 失败）。 */
  fallbackUsed: boolean;
}

/** 中文 / 英文常见疑问词；用于无 LLM 时的启发式判定。 */
const QUESTION_HINTS_ZH = [
  '什么', '为什么', '怎么', '怎样', '如何', '哪个', '哪里', '哪一', '是不是', '能不能',
  '有没有', '是否', '吗', '呢', '介绍一下', '解释', '讲一下', '讲解', '解说', '说说', '讲讲',
  '展开', '详细', '区别',
  '不同', '原理', '含义', '意思', '怎么理解', '是什么',
];
const QUESTION_HINTS_EN = [
  'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'is it', 'are you', 'does it', 'do you', 'can you', 'could you', 'explain', 'tell me',
];

function heuristicClassify(transcript: string): ClassifyResult {
  const t = transcript.trim();
  if (!t) return { intent: 'irrelevant', reason: '空文本', fallbackUsed: true };
  const lower = t.toLowerCase();
  if (/[?？]/.test(t)) {
    return { intent: 'question', reason: '包含问号', fallbackUsed: true };
  }
  for (const h of QUESTION_HINTS_ZH) {
    if (t.includes(h)) {
      return { intent: 'question', reason: `命中疑问词 "${h}"`, fallbackUsed: true };
    }
  }
  for (const h of QUESTION_HINTS_EN) {
    if (lower.includes(h)) {
      return { intent: 'question', reason: `命中疑问词 "${h}"`, fallbackUsed: true };
    }
  }
  // 没有问号、没有疑问词，又没有命中正则命令 → 默认认为是闲聊/噪音
  return { intent: 'irrelevant', reason: '未发现疑问/命令特征', fallbackUsed: true };
}

const SYSTEM_PROMPT = `你是一个语音交互意图分类器。你需要判断用户的一句口语转写文本是否为"针对当前 PPT 内容的有效提问"。
判断准则：
- 「问题」：用户希望你解释、扩展、回答与 PPT 内容相关的问题；典型句式包含疑问词（什么/为什么/怎么/如何/哪/吗）、问号、或上下文里清楚是在问 PPT 相关。
- 「无关」：闲聊、自言自语、与 PPT 主题无关、单纯的噪音/口误转写、或仅仅是在念读 PPT 文字。
仅输出严格的 JSON 对象，不要任何解释，字段：
{ "intent": "question" | "irrelevant", "reason": "<不超过 30 字的中文理由>" }`;

function buildContext(transcript: string, currentPage: number, pages: DemoPage[]): string {
  const around: DemoPage[] = [];
  for (let p = currentPage - 1; p <= currentPage + 1; p += 1) {
    const item = pages.find((x) => x.pageNo === p);
    if (item) around.push(item);
  }
  const block = around
    .map((p) => `### 第 ${p.pageNo} 页\n标题：${p.title}\n要点：${p.content}\n讲稿：${p.script ?? ''}`)
    .join('\n\n')
    .slice(0, 2000);
  return `当前页码：${currentPage}\n附近内容摘录：\n${block}\n\n用户语音转写：\n${transcript}`;
}

async function chatClassifyOnce(
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
      temperature: 0.1,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPayload },
      ],
    }),
    signal,
  });
  const bodyText = await r.text();
  if (!r.ok) {
    return { ok: false, status: r.status, body: bodyText.slice(0, 300) };
  }
  try {
    const j = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = j.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) return { ok: false, status: r.status, body: 'empty choices' };
    return { ok: true, content };
  } catch {
    return { ok: false, status: r.status, body: bodyText.slice(0, 200) };
  }
}

function parseClassify(content: string): ClassifyResult | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const intentRaw = typeof j.intent === 'string' ? j.intent.toLowerCase() : '';
    if (intentRaw !== 'question' && intentRaw !== 'irrelevant') return null;
    const reason = typeof j.reason === 'string' ? j.reason.slice(0, 60) : '';
    return { intent: intentRaw, reason: reason || '(无理由)', fallbackUsed: false };
  } catch {
    return null;
  }
}

/**
 * 用 LLM 判定 transcript 是否是"针对 PPT 的有效提问"。
 * - 无 OpenAI key / LLM 失败 → 启发式（含问号或疑问词视为 question）。
 * - 任何错误都不阻塞主链路。
 */
export async function classifyTranscriptIntent(input: {
  transcript: string;
  currentPage: number;
  pages: DemoPage[];
}): Promise<ClassifyResult> {
  const t = input.transcript.trim();
  if (!t) return { intent: 'irrelevant', reason: '空文本', fallbackUsed: true };

  const key = config.openaiApiKey?.trim() ?? '';
  if (!key) {
    return heuristicClassify(t);
  }

  const userPayload = buildContext(t, input.currentPage, input.pages);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(8000, config.qaLlmTimeoutMs));
  try {
    const one = await chatClassifyOnce(key, config.llmModel, userPayload, ctrl.signal);
    clearTimeout(timer);
    if (!one.ok) return heuristicClassify(t);
    const parsed = parseClassify(one.content);
    if (!parsed) return heuristicClassify(t);
    return parsed;
  } catch {
    clearTimeout(timer);
    return heuristicClassify(t);
  }
}
