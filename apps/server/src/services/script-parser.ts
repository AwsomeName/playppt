import type { PresentationScripts } from '../types/presentation.js';

/** 去掉 Markdown 控制字符，避免 TTS 把粗体/删除线/代码标记/标题井号等符号读出来。 */
export function stripMarkdown(text: string): string {
  let s = text;
  // 图片 ![alt](url) → 移除整段
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 链接 [text](url) → 只保留文字
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 删除线 ~~text~~
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // 粗体 **text** 或 __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 斜体 *text* 或 _text_（不要误杀列表前缀的 *，它们在行首且后面有空格）
  s = s.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
  // 行首列表标记：- item / * item / + item → 只保留内容
  s = s.replace(/^[\s]*[-*+]\s+/gm, '');
  // 有序列表：1. item → 只保留内容
  s = s.replace(/^[\s]*\d+\.\s+/gm, '');
  // 行首标题标记 # → 去掉
  s = s.replace(/^#+\s+/gm, '');
  // 引用 > （行首） → 去掉
  s = s.replace(/^>\s+/gm, '');
  // 代码块 ```lang ... ``` → 去掉标记，保留内容
  s = s.replace(/```[^\n]*\n?/g, '');
  s = s.replace(/```/g, '');
  // 行内代码 `code` → 去掉反引号
  s = s.replace(/`([^`]+)`/g, '$1');
  // HTML 标签 → 去掉
  s = s.replace(/<[^>]+>/g, '');
  // 多余空行合并
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const ZH_DIGIT: Record<string, number> = {
  '〇': 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 将"一"/"十"/"二十一"/"三十三"/"一百零三"等中文数字解析为整数；非法返回 null。 */
export function parseZhInt(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  let n = 0;
  const hi = s.indexOf('百');
  if (hi >= 0) {
    const head = s.slice(0, hi);
    const d = ZH_DIGIT[head];
    if (d == null || d === 0) return null;
    n += d * 100;
    s = s.slice(hi + 1);
  }
  const ti = s.indexOf('十');
  if (ti >= 0) {
    const head = s.slice(0, ti);
    let dec: number;
    if (head === '') {
      dec = 1;
    } else {
      const d = ZH_DIGIT[head];
      if (d == null || d === 0) return null;
      dec = d;
    }
    n += dec * 10;
    s = s.slice(ti + 1);
  }
  s = s.replace(/^零/, '');
  if (s.length === 1) {
    const d = ZH_DIGIT[s];
    if (d == null) return null;
    n += d;
  } else if (s.length > 1) {
    return null;
  }
  return n > 0 ? n : null;
}

// 标准独立行的"第X页"页头：可能是 第一页 / 第1页 / 第三十三页 等。
// 只允许整行就是页号（可在末尾出现可选标题，分隔符为 · • : ：等），
// 避免误把句子中"在第一页中"识别为页头。
const PAGE_HEADER_RE =
  /^\s*第\s*([零〇一二三四五六七八九十百两\d]+)\s*页(?:\s*[·•:：\-—]\s*.*)?\s*$/;

interface PageHeaderMatch {
  lineIdx: number;
  pageNo: number;
}

function findPageHeaders(lines: string[]): PageHeaderMatch[] {
  const out: PageHeaderMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PAGE_HEADER_RE.exec(lines[i]!);
    if (!m) continue;
    const pn = parseZhInt(m[1]!);
    if (pn != null) out.push({ lineIdx: i, pageNo: pn });
  }
  return out;
}

/**
 * 当文档以"第X页"独占一行作为分隔（中文或阿拉伯数字）时按页号头解析。
 * 至少识别到 2 个页头才视为该格式，否则返回 null 让上层回退。
 */
function parseByPageHeaders(content: string, totalPages: number): PresentationScripts | null {
  const lines = content.split('\n');
  const matches = findPageHeaders(lines);
  if (matches.length < 2) return null;

  const pageMap = new Map<number, string>();
  for (let k = 0; k < matches.length; k++) {
    const start = matches[k]!.lineIdx + 1;
    const end = k + 1 < matches.length ? matches[k + 1]!.lineIdx : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    if (body) pageMap.set(matches[k]!.pageNo, body);
  }
  if (pageMap.size === 0) return null;

  const scripts: PresentationScripts['scripts'] = [];
  for (let i = 1; i <= totalPages; i++) {
    let body = pageMap.get(i);
    if (!body) {
      // 缺页用最近的非空内容兜底（先后再前），避免空稿
      for (let d = 1; d <= totalPages && !body; d++) {
        body = pageMap.get(i + d) ?? pageMap.get(i - d);
      }
    }
    scripts.push({ pageNo: i, script: stripMarkdown(body || '') });
  }
  return { scripts };
}

/**
 * 将上传的解说稿（.md/.txt/.markdown）解析为 PresentationScripts。
 * 优先识别以"第X页"独占一行的页号头格式（中文或阿拉伯数字）。
 * 回退到旧逻辑：按 ## 标题或 --- 切分、识别开场/收尾/附录、平均分配到页。
 */
export function parseScriptContent(content: string, totalPages: number): PresentationScripts {
  // 先尝试新格式：以"第X页"独立行分隔的稿件（页号头会被丢弃，不进入 script 内容）
  const byPage = parseByPageHeaders(content, totalPages);
  if (byPage) return byPage;

  // 去掉文件头部元数据（blockquote >、# 一级标题、整行斜体元数据）
  const cleanedLines = content
    .split('\n')
    .filter((line) => !/^>\s/.test(line) && !/^#\s/.test(line) && !/^\*.*\*$/.test(line.trim()));
  const cleaned = cleanedLines.join('\n').trim();

  // 按 ## 标题或 --- 切分章节，并记录标题用于识别开场/收尾/附录
  const OPENING_RE = /开场|开篇|序幕/;
  const CLOSING_RE = /收尾|结尾|结束|结语|总结|致谢|感谢/;
  const APPENDIX_RE = /附[：:]|附录/;
  const sections: { title: string; body: string }[] = [];
  let curTitle = '';
  let curBody = '';
  for (const line of cleanedLines) {
    if (/^##\s/.test(line)) {
      if (curBody.trim()) sections.push({ title: curTitle, body: curBody.trim() });
      curTitle = line.replace(/^##\s+/, '').trim();
      curBody = '';
    } else if (/^---/.test(line)) {
      if (curBody.trim()) sections.push({ title: curTitle, body: curBody.trim() });
      curTitle = '';
      curBody = '';
    } else {
      curBody += line + '\n';
    }
  }
  if (curBody.trim()) sections.push({ title: curTitle, body: curBody.trim() });

  // 没有 ## 或 --- 时按连续空行分割（无标题）
  if (sections.length <= 1) {
    const parts = cleaned.split(/\n{2,}/).filter((p) => p.trim());
    sections.length = 0;
    for (const p of parts) sections.push({ title: '', body: p.trim() });
  }
  if (sections.length === 0) sections.push({ title: '', body: cleaned });

  // 提取开场白和收尾；附录类章节直接丢弃（不分配到页面）
  let opening: string | undefined;
  let closing: string | undefined;
  const pageSections: string[] = [];
  for (const sec of sections) {
    if (!opening && OPENING_RE.test(sec.title)) {
      opening = sec.body;
    } else if (!closing && CLOSING_RE.test(sec.title)) {
      closing = sec.body;
    } else if (APPENDIX_RE.test(sec.title)) {
      // 附录（如时长控制建议表）不分配到页面
    } else {
      pageSections.push(sec.body);
    }
  }

  // 均匀分配章节到每页：不足时复用最近章节
  const scripts: PresentationScripts['scripts'] = [];
  for (let i = 0; i < totalPages; i++) {
    const idx =
      pageSections.length >= totalPages
        ? i
        : Math.floor((i * pageSections.length) / totalPages);
    const script = stripMarkdown(
      pageSections[idx] || pageSections[pageSections.length - 1] || '',
    );
    scripts.push({ pageNo: i + 1, script });
  }
  return {
    opening: opening ? stripMarkdown(opening) : undefined,
    closing: closing ? stripMarkdown(closing) : undefined,
    scripts,
  };
}
