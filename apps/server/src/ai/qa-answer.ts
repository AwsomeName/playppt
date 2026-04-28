import { config } from '../config.js';
import type { DemoPage, KnowledgeBaseChunk } from '../types/presentation.js';
import { clampSourcePages, completeQaJson, mockAnswerFromRetrieval } from './openai-qa.js';
import { retrievePageContext } from './page-retrieval.js';

export type QaPipelineResult = {
  answerText: string;
  sourcePages: number[];
  confidence: number;
  /** true：无 Key、LLM 超时/连续失败等，已走检索降级（对应 2.1D，会话应置 fallbackMode） */
  llmUnavailable: boolean;
  /**
   * true：LLM 侧超时，或多次重试后仍以 5xx 失败（ai-dev-plan 4.8）。
   * 仍返回检索降级文本，但会话应进入 interrupted + fallbackMode。
   */
  recoverableInfrastructureFailure: boolean;
  /** 最后一次 LLM 调用链路的尝试次数（无 Key 时为 0） */
  llmAttemptsUsed: number;
};

export async function runQaPipeline(input: {
  pages: DemoPage[];
  question: string;
  currentPage: number;
  kb?: KnowledgeBaseChunk[];
}): Promise<QaPipelineResult> {
  const { chunks, candidateSourcePages } = retrievePageContext(
    input.pages,
    input.question,
    input.currentPage,
    input.kb ?? [],
  );

  const key = config.openaiApiKey?.trim() ?? '';
  if (!key) {
    const m = mockAnswerFromRetrieval(input.question, chunks);
    return {
      answerText: m.answerText,
      sourcePages: m.sourcePages.length ? m.sourcePages : candidateSourcePages.slice(0, 1),
      confidence: m.confidence,
      llmUnavailable: true,
      recoverableInfrastructureFailure: false,
      llmAttemptsUsed: 0,
    };
  }

  const allowedPages = new Set(chunks.map((c) => c.pageNo));
  const llm = await completeQaJson({
    apiKey: key,
    model: config.llmModel,
    question: input.question,
    chunks,
    timeoutMs: config.qaLlmTimeoutMs,
  });

  if (!llm.ok) {
    const authFail = llm.reason === 'http' && llm.status === 401;
    const recoverableInfrastructureFailure =
      llm.reason === 'timeout' ||
      (llm.reason === 'http' &&
        typeof llm.status === 'number' &&
        llm.status >= 500 &&
        llm.status < 600);
    const m = mockAnswerFromRetrieval(input.question, chunks);
    return {
      answerText: m.answerText,
      sourcePages: m.sourcePages.length ? m.sourcePages : candidateSourcePages.slice(0, 1),
      confidence: Math.min(m.confidence, authFail ? 0.2 : 0.38),
      llmUnavailable: true,
      recoverableInfrastructureFailure,
      llmAttemptsUsed: llm.attemptsUsed,
    };
  }

  let sourcePages = clampSourcePages(llm.parsed.sourcePages, allowedPages);
  if (sourcePages.length === 0 && candidateSourcePages.length > 0) {
    sourcePages = [candidateSourcePages[0]!];
  }

  let confidence = llm.parsed.confidence;
  if (llm.parsed.cannotConfirm) {
    confidence = Math.min(confidence, 0.42);
  }

  return {
    answerText: llm.parsed.answerText,
    sourcePages,
    confidence,
    llmUnavailable: false,
    recoverableInfrastructureFailure: false,
    llmAttemptsUsed: llm.attemptsUsed,
  };
}
