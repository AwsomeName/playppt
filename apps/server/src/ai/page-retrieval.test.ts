import { describe, expect, it } from 'vitest';

import type { DemoPage, KnowledgeBaseChunk } from '../types/presentation.js';
import { buildPageCorpus, retrievePageContext, tokenizeQuestion } from './page-retrieval.js';

const pages: DemoPage[] = [
  { pageNo: 1, title: '封面', content: '欢迎', script: '开场白 alpha' },
  { pageNo: 2, title: '架构', content: 'apps web server', script: '讲解 node react' },
  { pageNo: 3, title: '无关', content: 'foo bar', script: 'baz' },
];

describe('page-retrieval', () => {
  it('buildPageCorpus joins fields', () => {
    expect(buildPageCorpus(pages[1]!)).toContain('架构');
    expect(buildPageCorpus(pages[1]!)).toContain('react');
  });

  it('tokenizeQuestion extracts words', () => {
    expect(tokenizeQuestion('  Node.js 与 React  ')).toContain('node');
    expect(tokenizeQuestion('  Node.js 与 React  ')).toContain('js');
  });

  it('retrievePageContext prefers current page when score is strong', () => {
    const { chunks, candidateSourcePages } = retrievePageContext(pages, 'react 架构', 2);
    expect(candidateSourcePages).toContain(2);
    expect(chunks.every((c) => c.pageNo === 2)).toBe(true);
  });

  it('retrievePageContext expands when current page is weak', () => {
    const { chunks } = retrievePageContext(pages, 'alpha 开场', 3);
    const nos = chunks.map((c) => c.pageNo);
    expect(nos).toContain(1);
    expect(nos.length).toBeGreaterThanOrEqual(1);
  });

  it('retrievePageContext includes knowledge base when terms match', () => {
    const kb: KnowledgeBaseChunk[] = [
      { id: 'k1', title: '外部术语表', body: 'play-ppt 使用 WebSocket 连接火山云语音服务。' },
    ];
    const { chunks } = retrievePageContext(pages, 'WebSocket 火山', 2, kb);
    expect(chunks.some((c) => c.pageNo === 0)).toBe(true);
  });
});
