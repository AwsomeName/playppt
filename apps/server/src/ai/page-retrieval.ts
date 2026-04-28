import type { DemoPage, KnowledgeBaseChunk } from '../types/presentation.js';

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** 与 ai-dev-plan 1.1.3 一致：默认可检索语料为 title + content + script 拼块 */
export function buildPageCorpus(page: DemoPage): string {
  return [page.title, page.content, page.script].filter(Boolean).join('\n');
}

export function tokenizeQuestion(question: string): string[] {
  const m = question.toLowerCase().match(WORD_RE);
  if (!m?.length) return [];
  return [...m];
}

function scoreDocument(corpus: string, terms: string[]): number {
  const d = corpus.toLowerCase();
  let s = 0;
  const seen = new Set<string>();
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc, 'gi');
    let c = 0;
    const hits = d.match(re);
    c = hits ? Math.min(hits.length, 6) : 0;
    if (c) s += Math.min(c, 5);
  }
  return s;
}

export type RetrievedChunk = { pageNo: number; text: string };

/**
 * 先当前页、命中不足再扩全局：按词重叠打分，选取若干页的摘录块供 LLM。
 */
export function retrievePageContext(
  pages: DemoPage[],
  question: string,
  currentPage: number,
  kbChunks: KnowledgeBaseChunk[] = [],
): { chunks: RetrievedChunk[]; candidateSourcePages: number[] } {
  const terms = tokenizeQuestion(question);
  const maxPageNo = Math.max(1, ...pages.map((p) => p.pageNo));
  const clamped = Math.min(Math.max(1, Math.trunc(currentPage)), maxPageNo);

  const byNo = new Map(pages.map((p) => [p.pageNo, p] as const));
  const curPage = byNo.get(clamped) ?? pages[0];
  if (!curPage) {
    return { chunks: [], candidateSourcePages: [] };
  }

  if (terms.length === 0) {
    const text = buildPageCorpus(curPage);
    return {
      chunks: [{ pageNo: curPage.pageNo, text }],
      candidateSourcePages: [curPage.pageNo],
    };
  }

  const scored = pages.map((pg) => ({
    pageNo: pg.pageNo,
    score: scoreDocument(buildPageCorpus(pg), terms),
    corpus: buildPageCorpus(pg),
  }));
  scored.sort((a, b) => b.score - a.score);
  const maxS = scored[0]?.score ?? 0;
  const curRow = scored.find((x) => x.pageNo === clamped);
  const curS = curRow?.score ?? 0;

  let picked: typeof scored = [];
  if (maxS === 0) {
    picked = [curRow ?? scored[0]!];
  } else if (curS >= maxS * 0.5) {
    picked = [curRow ?? { pageNo: clamped, score: curS, corpus: buildPageCorpus(curPage) }];
  } else {
    const map = new Map<number, (typeof scored)[0]>();
    const add = (row: (typeof scored)[0]) => {
      if (!map.has(row.pageNo)) map.set(row.pageNo, row);
    };
    if (curRow && curRow.score > 0) add(curRow);
    for (const row of scored) {
      if (map.size >= 3) break;
      if (row.score > 0) add(row);
    }
    if (map.size === 0) add(scored[0]!);
    picked = [...map.values()].sort((a, b) => b.score - a.score);
  }

  const MAX_CHARS = 12000;
  const chunks: RetrievedChunk[] = [];
  let used = 0;
  for (const row of picked) {
    let t = row.corpus;
    if (used + t.length > MAX_CHARS) {
      t = t.slice(0, Math.max(0, MAX_CHARS - used));
    }
    if (t.length === 0) continue;
    chunks.push({ pageNo: row.pageNo, text: t });
    used += t.length;
    if (used >= MAX_CHARS) break;
  }

  const kbHits = kbChunks
    .map((k) => ({
      score: scoreDocument(`${k.title}\n${k.body}`, terms),
      text: `[${k.id}] ${k.title}\n${k.body}`.trim(),
    }))
    .filter((x) => x.score > 0 && x.text.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  let usedKb = used;
  for (const h of kbHits) {
    let t = h.text;
    if (usedKb + t.length > MAX_CHARS) {
      t = t.slice(0, Math.max(0, MAX_CHARS - usedKb));
    }
    if (t.length === 0) continue;
    chunks.push({ pageNo: 0, text: t });
    usedKb += t.length;
    if (usedKb >= MAX_CHARS) break;
  }

  const candidateSourcePages = [...new Set(chunks.map((c) => c.pageNo))];
  return { chunks, candidateSourcePages };
}
