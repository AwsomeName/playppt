import { describe, expect, it } from 'vitest';

import { clampSourcePages, parseLlmQaJson } from './openai-qa.js';

describe('openai-qa', () => {
  it('parseLlmQaJson parses bare JSON', () => {
    const p = parseLlmQaJson(
      '{"answerText":"你好","sourcePages":[2,3],"confidence":0.9,"cannotConfirm":false}',
    );
    expect(p?.answerText).toBe('你好');
    expect(p?.sourcePages).toEqual([2, 3]);
    expect(p?.confidence).toBe(0.9);
  });

  it('parseLlmQaJson strips markdown fence', () => {
    const raw = '```json\n{"answerText":"x","sourcePages":[1],"confidence":0.5}\n```';
    const p = parseLlmQaJson(raw);
    expect(p?.answerText).toBe('x');
  });

  it('clampSourcePages filters to allowed', () => {
    expect(clampSourcePages([1, 99, 2], new Set([1, 2]))).toEqual([1, 2]);
  });

  it('parseLlmQaJson allows sourcePages 0 for knowledge base', () => {
    const p = parseLlmQaJson('{"answerText":"x","sourcePages":[0,2],"confidence":0.5}');
    expect(p?.sourcePages).toEqual([0, 2]);
  });

  it('clampSourcePages keeps page 0 when allowed', () => {
    expect(clampSourcePages([0, 2], new Set([0, 2]))).toEqual([0, 2]);
  });
});
