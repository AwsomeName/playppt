import { describe, expect, it } from 'vitest';

import { parseKbContent } from './kb-parser.js';

describe('parseKbContent — table-only doc (问答.md style)', () => {
  it('treats each consecutive markdown table as one chunk', () => {
    const md = [
      '| 维度 | 判断 |',
      '| --- | --- |',
      '| 2025年狭义市场 | ~5,300亿元 |',
      '| 2025年广义市场 | ~8,900亿元 |',
      '',
      '| 枢纽 | 所在区域 | 定位/特色 |',
      '| --- | --- | --- |',
      '| 京津冀枢纽 | 北京、天津、河北 | 政治中心、AI大模型 |',
    ].join('\n');

    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0]).toMatchObject({
      id: 'kb-1',
      title: '维度 · 判断',
    });
    expect(r.chunks[0]!.body).toContain('2025年狭义市场');
    expect(r.chunks[0]!.body).toMatch(/^\| 维度 \| 判断 \|/);
    expect(r.chunks[1]).toMatchObject({
      id: 'kb-2',
      title: '枢纽 · 所在区域 · 定位/特色',
    });
    expect(r.chunks[1]!.body).toContain('京津冀枢纽');
  });

  it('strips bold/italic from table headers used as title', () => {
    const md = [
      '| **维度** | _判断_ |',
      '| --- | --- |',
      '| A | B |',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks[0]!.title).toBe('维度 · 判断');
  });
});

describe('parseKbContent — heading sections', () => {
  it('uses ## headings as chunk titles, includes following body', () => {
    const md = [
      '# 文档标题',
      '',
      '> 元数据一行',
      '',
      '## 什么是算电协同？',
      '答：通过统一调度让算力和电力在时空上协同。',
      '',
      '## 哪些枢纽可调？',
      '京津冀、长三角、粤港澳、成渝、内蒙古、贵州、甘肃、宁夏。',
    ].join('\n');

    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0]).toMatchObject({
      id: 'kb-1',
      title: '什么是算电协同？',
    });
    expect(r.chunks[0]!.body).toContain('统一调度');
    expect(r.chunks[1]!.title).toBe('哪些枢纽可调？');
  });

  it('treats nested ### heading inside ## section as still part of body until same/upper-level heading', () => {
    const md = [
      '## 大类 A',
      '简介。',
      '',
      '### 子条目',
      '细节内容。',
      '',
      '## 大类 B',
      'B 内容。',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0]!.title).toBe('大类 A');
    expect(r.chunks[0]!.body).toContain('### 子条目');
    expect(r.chunks[0]!.body).toContain('细节内容。');
    expect(r.chunks[1]!.title).toBe('大类 B');
  });
});

describe('parseKbContent — paragraphs & mixed', () => {
  it('falls back to paragraph blocks when no headings/tables', () => {
    const md = [
      '算力调度核心是按时空错峰分配负载。',
      '',
      '电力交易依靠预测模型在中长期与现货之间套利。',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0]!.title).toContain('算力调度');
    expect(r.chunks[1]!.title).toContain('电力交易');
  });

  it('mixes headings, tables and paragraphs into separate chunks', () => {
    const md = [
      '## 概述',
      '一段说明。',
      '',
      '| 指标 | 数值 |',
      '| --- | --- |',
      '| PUE | 1.18 |',
      '',
      '## 备注',
      '尾段说明。',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(3);
    expect(r.chunks[0]!.title).toBe('概述');
    expect(r.chunks[1]!.title).toBe('指标 · 数值');
    expect(r.chunks[2]!.title).toBe('备注');
  });
});

describe('parseKbContent — id/title uniqueness & edge cases', () => {
  it('generates unique kb-N ids and disambiguates duplicate titles', () => {
    const md = [
      '## 同名',
      'A',
      '',
      '## 同名',
      'B',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks.map((c) => c.id)).toEqual(['kb-1', 'kb-2']);
    expect(r.chunks[0]!.title).toBe('同名');
    expect(r.chunks[1]!.title).toBe('同名（2）');
  });

  it('returns empty chunks for empty / whitespace-only input', () => {
    expect(parseKbContent('').chunks).toHaveLength(0);
    expect(parseKbContent('   \n\n  \n').chunks).toHaveLength(0);
  });

  it('skips H1, blockquote and italic-only metadata at the top', () => {
    const md = [
      '# 文档标题',
      '*生成时间：2026-05-07*',
      '> 备注',
      '',
      '## 实际章节',
      '内容。',
    ].join('\n');
    const r = parseKbContent(md);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.title).toBe('实际章节');
  });
});
