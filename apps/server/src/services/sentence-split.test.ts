import { describe, expect, it } from 'vitest';

import { splitSentences } from './sentence-split.js';

describe('splitSentences', () => {
  it('returns empty array for empty input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('splits Chinese sentences at punctuation', () => {
    const r = splitSentences('今天我们来讲一讲人工智能的应用场景。它在多个领域都有应用。');
    expect(r).toEqual([
      '今天我们来讲一讲人工智能的应用场景。',
      '它在多个领域都有应用。',
    ]);
  });

  it('keeps trailing fragment without punctuation', () => {
    expect(splitSentences('你好。世界')).toEqual(['你好。世界']);
  });

  it('merges very short leading sentence into next one', () => {
    // "好。"3 个字符 < 6，应被合并
    expect(splitSentences('好。明天会更好。')).toEqual(['好。明天会更好。']);
  });

  it('merges very short trailing sentence into previous one', () => {
    // 倒数第二句 "今天我们来讲一讲。" 长度足够；末尾 "好。" < 6 会被合并
    expect(splitSentences('今天我们来讲一讲。好。')).toEqual(['今天我们来讲一讲。好。']);
  });

  it('handles question and exclamation marks', () => {
    const r = splitSentences('你听到了吗？我有一个问题！请回答。');
    expect(r).toEqual(['你听到了吗？', '我有一个问题！', '请回答。']);
  });

  it('handles English punctuation', () => {
    const r = splitSentences('Hello world. This is a test! Right?');
    expect(r).toEqual(['Hello world.', 'This is a test!', 'Right?']);
  });

  it('returns single chunk when no punctuation', () => {
    expect(splitSentences('一段没有标点的话')).toEqual(['一段没有标点的话']);
  });
});
