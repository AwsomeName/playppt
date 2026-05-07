import type { KnowledgeBaseChunk, PresentationKb } from '../types/presentation.js';

/** 仅用于 title：去掉粗体/斜体/反引号/链接等装饰，保留可读文字。 */
function cleanTitle(text: string): string {
  let s = text;
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

interface RawBlock {
  title: string;
  body: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const ITALIC_META_RE = /^\*[^*]+\*$/;

function isBlockBoundary(line: string): boolean {
  return !line.trim();
}

function parseTableHeaders(headerLine: string): string[] {
  return headerLine
    .split('|')
    .map((c) => cleanTitle(c))
    .filter((c) => c.length > 0);
}

function isTableSeparatorRow(line: string): boolean {
  // 形如 | --- | --- |（允许冒号对齐符）
  if (!TABLE_LINE_RE.test(line)) return false;
  const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * 将上传的知识库文档（.md/.txt/.markdown）解析为 PresentationKb。
 * 支持的块：
 * - `## / ### ...` 标题段：title=标题文本，body=该标题下到下一个标题/分隔线为止的内容；
 * - 连续 `|...|` 行的 Markdown 表格：title=列头拼接，body=保留原 Markdown 表格；
 * - 段落（空行分隔的纯文本/列表）：title=首行前若干字。
 * id 自动生成 `kb-N`；title 重复时追加 `（2）/（3）` 去重；body 保留 Markdown 原貌以便检索。
 */
export function parseKbContent(content: string): PresentationKb {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RawBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 跳过空行
    if (isBlockBoundary(line)) {
      i++;
      continue;
    }

    // 跳过文档级元数据：H1、blockquote、整行斜体说明
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1]!.length === 1) {
      i++;
      continue;
    }
    if (/^>\s/.test(line)) {
      i++;
      continue;
    }
    if (ITALIC_META_RE.test(line.trim())) {
      i++;
      continue;
    }
    // 顶层 --- 分隔线（YAML front-matter 或章节分隔）
    if (/^---+\s*$/.test(line)) {
      i++;
      continue;
    }

    // H2-H6：作为一个 chunk，body = 该标题下直到下一个 同/上级标题、---、表格 或 EOF 的内容。
    // 表格会打断 section（独立成块更利于检索），子级标题（更深）继续算作 body 的一部分。
    if (heading && heading[1]!.length >= 2) {
      const headingDepth = heading[1]!.length;
      const title = cleanTitle(heading[2]!);
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        const nh = HEADING_RE.exec(next);
        if (nh && nh[1]!.length <= headingDepth) break;
        if (/^---+\s*$/.test(next)) break;
        if (TABLE_LINE_RE.test(next)) break;
        buf.push(next);
        i++;
      }
      const body = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (title || body) blocks.push({ title: title || '段落', body });
      continue;
    }

    // 表格：连续以 `|` 开头的行视为同一张表
    if (TABLE_LINE_RE.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && TABLE_LINE_RE.test(lines[i]!)) {
        tableLines.push(lines[i]!);
        i++;
      }
      const headerLine = tableLines[0]!;
      const headers = parseTableHeaders(headerLine);
      // 若第二行是分隔行，作为表的分割线展示，但 title 仅取第一行列头
      let title = headers.length > 0 ? headers.join(' · ') : '表格';
      // 列头若全是 ---，说明这一行是分隔行（无表头）；尝试用第二行的内容当作"标题"
      if (headers.every((h) => /^:?-{3,}:?$/.test(h))) {
        const second = tableLines[1];
        if (second) {
          const cells = parseTableHeaders(second);
          title = cells.length > 0 ? cells.join(' · ') : '表格';
        } else {
          title = '表格';
        }
      }
      // 若第二行是分隔行就保持完整 markdown 表格；若不是分隔行也仍照原文保留
      const body = tableLines.join('\n').trim();
      blocks.push({ title, body });
      continue;
    }

    // 普通段落：连续非空、非表格、非标题行
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      if (isBlockBoundary(cur)) break;
      if (TABLE_LINE_RE.test(cur)) break;
      if (HEADING_RE.test(cur)) break;
      para.push(cur);
      i++;
    }
    if (para.length) {
      const body = para.join('\n').trim();
      const firstLine = para[0]!
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .replace(/^[#>]+\s*/, '');
      const baseTitle = cleanTitle(firstLine).slice(0, 40);
      blocks.push({ title: baseTitle || '段落', body });
    }
  }

  // title 去重；统一生成 id；过滤掉 body 为空的块
  const seen = new Map<string, number>();
  const chunks: KnowledgeBaseChunk[] = [];
  for (const b of blocks) {
    if (!b.body) continue;
    let title = b.title || '段落';
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    if (n > 1) title = `${title}（${n}）`;
    chunks.push({
      id: `kb-${chunks.length + 1}`,
      title,
      body: b.body,
    });
  }
  return { chunks };
}
