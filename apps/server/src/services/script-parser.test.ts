import { describe, expect, it } from 'vitest';

import { parseScriptContent, parseZhInt, stripMarkdown } from './script-parser.js';

describe('parseZhInt', () => {
  it('parses Arabic digits', () => {
    expect(parseZhInt('1')).toBe(1);
    expect(parseZhInt('33')).toBe(33);
    expect(parseZhInt('100')).toBe(100);
  });

  it('parses single Chinese digits', () => {
    expect(parseZhInt('一')).toBe(1);
    expect(parseZhInt('九')).toBe(9);
  });

  it('parses 十 and 十X', () => {
    expect(parseZhInt('十')).toBe(10);
    expect(parseZhInt('十一')).toBe(11);
    expect(parseZhInt('十九')).toBe(19);
  });

  it('parses X十 and X十Y', () => {
    expect(parseZhInt('二十')).toBe(20);
    expect(parseZhInt('二十一')).toBe(21);
    expect(parseZhInt('三十三')).toBe(33);
    expect(parseZhInt('九十九')).toBe(99);
  });

  it('parses 一百 / 一百零三 / 一百二十三', () => {
    expect(parseZhInt('一百')).toBe(100);
    expect(parseZhInt('一百零三')).toBe(103);
    expect(parseZhInt('一百二十三')).toBe(123);
  });

  it('returns null for invalid input', () => {
    expect(parseZhInt('')).toBeNull();
    expect(parseZhInt('abc')).toBeNull();
    expect(parseZhInt('一二')).toBeNull();
  });
});

describe('stripMarkdown', () => {
  it('removes bold/italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  it('preserves bullet text but drops markers', () => {
    expect(stripMarkdown('- a\n- b')).toBe('a\nb');
  });
});

describe('parseScriptContent (new 第X页 header format)', () => {
  it('splits by Chinese page-number headers and drops the header line', () => {
    const md = [
      '第一页',
      '中国联通与中科类脑联合推出算电协同解决方案。',
      '',
      '第二页',
      '本次演讲将围绕五个关键板块展开。',
      '',
      '第三页',
      '首先，分析行业政策。',
    ].join('\n');

    const r = parseScriptContent(md, 3);
    expect(r.scripts).toHaveLength(3);
    expect(r.scripts[0]).toEqual({
      pageNo: 1,
      script: '中国联通与中科类脑联合推出算电协同解决方案。',
    });
    expect(r.scripts[1]).toEqual({
      pageNo: 2,
      script: '本次演讲将围绕五个关键板块展开。',
    });
    expect(r.scripts[2]).toEqual({
      pageNo: 3,
      script: '首先，分析行业政策。',
    });
    // 没有显式开场/收尾标记
    expect(r.opening).toBeUndefined();
    expect(r.closing).toBeUndefined();
    // 关键诉求：解说词中不再保留"第X页"
    for (const s of r.scripts) {
      expect(s.script).not.toMatch(/第[一二三四五六七八九十百零\d]+页/);
    }
  });

  it('handles multi-paragraph bodies between headers', () => {
    const md = [
      '第一页',
      '第一段。',
      '',
      '第二段。',
      '',
      '第二页',
      '只有一段。',
    ].join('\n');
    const r = parseScriptContent(md, 2);
    expect(r.scripts[0]!.script).toBe('第一段。\n\n第二段。');
    expect(r.scripts[1]!.script).toBe('只有一段。');
  });

  it('respects page numbers from headers (non-contiguous → fallback fills gaps)', () => {
    const md = ['第一页', 'A', '', '第三页', 'C'].join('\n');
    const r = parseScriptContent(md, 3);
    expect(r.scripts[0]!.script).toBe('A');
    // 缺失的第 2 页用最近页兜底（取后一页）
    expect(r.scripts[1]!.script).toBe('C');
    expect(r.scripts[2]!.script).toBe('C');
  });

  it('also accepts Arabic-numeral standalone page headers', () => {
    const md = ['第1页', 'A', '', '第2页', 'B'].join('\n');
    const r = parseScriptContent(md, 2);
    expect(r.scripts[0]!.script).toBe('A');
    expect(r.scripts[1]!.script).toBe('B');
  });

  it('does NOT mistake "在第一页中..." inline mention as a header', () => {
    const md = [
      '第一页',
      '在第一页中我们介绍方案。',
      '',
      '第二页',
      '具体内容。',
    ].join('\n');
    const r = parseScriptContent(md, 2);
    // 内联引用不应被切分；只有独占行的"第X页"才视为页头
    expect(r.scripts[0]!.script).toBe('在第一页中我们介绍方案。');
    expect(r.scripts[1]!.script).toBe('具体内容。');
  });
});

describe('parseScriptContent (legacy ## section format)', () => {
  it('extracts opening / closing and distributes section bodies to pages', () => {
    const md = [
      '# 标题',
      '',
      '> 元数据',
      '',
      '## 开场',
      '欢迎大家。',
      '',
      '## 第1页 · 封面',
      '封面内容。',
      '',
      '## 第2页 · 主体',
      '主体内容。',
      '',
      '## 结尾',
      '感谢各位。',
      '',
      '## 附：备注',
      '附录不应进入页内容。',
    ].join('\n');

    const r = parseScriptContent(md, 2);
    expect(r.opening).toBe('欢迎大家。');
    expect(r.closing).toBe('感谢各位。');
    expect(r.scripts).toHaveLength(2);
    expect(r.scripts[0]!.script).toBe('封面内容。');
    expect(r.scripts[1]!.script).toBe('主体内容。');
    // 附录内容不应混入任何页
    for (const s of r.scripts) {
      expect(s.script).not.toContain('附录');
    }
  });
});
