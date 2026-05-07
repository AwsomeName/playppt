import { describe, expect, it } from 'vitest';

import { classifyTranscriptIntent } from './intent-classify.js';
import type { DemoPage } from '../types/presentation.js';

/**
 * 启发式分支（无 OPENAI_API_KEY 时生效）。
 * 这里默认 process.env.OPENAI_API_KEY 在测试环境为空（apps/server 的 vitest 没有注入）。
 */

const pages: DemoPage[] = [
  { pageNo: 1, title: '封面', content: '算电协同总览', script: '联通 × 类脑。' },
  { pageNo: 2, title: '东数西算', content: '八大枢纽十大集群全面启动。', script: '' },
];

const ctx = (transcript: string) => ({
  transcript,
  currentPage: 1,
  pages,
});

describe('classifyTranscriptIntent — heuristic (no LLM key)', () => {
  it('classifies "东数西算的枢纽有哪些" as question (单字"哪"命中)', async () => {
    const r = await classifyTranscriptIntent(ctx('东数西算的枢纽有哪些'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('question');
  });

  it('classifies real ASR fragment "我想问一下，呃，直算东东数西。" as question', async () => {
    const r = await classifyTranscriptIntent(ctx('我想问一下，呃，直算东东数西。'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('question');
  });

  it('classifies "请问八大枢纽都在哪些省份" as question', async () => {
    const r = await classifyTranscriptIntent(ctx('请问八大枢纽都在哪些省份'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('question');
  });

  it('classifies "市场规模有多少" as question', async () => {
    const r = await classifyTranscriptIntent(ctx('市场规模有多少'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('question');
  });

  it('classifies "讲一下东数西算" as question (描述性请求)', async () => {
    const r = await classifyTranscriptIntent(ctx('讲一下东数西算'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('question');
  });

  it('classifies plain statements without question hints as irrelevant', async () => {
    const r = await classifyTranscriptIntent(ctx('能源局首批新型电力系统示范。'));
    expect(r.fallbackUsed).toBe(true);
    expect(r.intent).toBe('irrelevant');
  });

  it('classifies empty / whitespace as irrelevant', async () => {
    expect((await classifyTranscriptIntent(ctx(''))).intent).toBe('irrelevant');
    expect((await classifyTranscriptIntent(ctx('   '))).intent).toBe('irrelevant');
  });

  it('classifies any sentence with question mark as question', async () => {
    const r = await classifyTranscriptIntent(ctx('这是什么。'));
    expect(r.intent).toBe('question');
  });
});
