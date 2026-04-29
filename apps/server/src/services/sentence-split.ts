/**
 * 中文讲稿分句：在句末标点（。！？；…!?.\n）处切分，保留标点；
 * 过短的相邻句合并到上一句，避免 TTS 单独合成"嗯。"等极短片段质量差。
 *
 * 注意：刻意不切分逗号 / 顿号 / 冒号——句间停顿 280ms 已足够，逗号停顿如果再切，节奏会过散。
 */
export interface SplitOptions {
  /** 合并阈值；相邻句若长度 < 该值则合并到上一句。默认 4 个字符。 */
  minLen?: number;
}

export function splitSentences(text: string, opts: SplitOptions = {}): string[] {
  const minLen = opts.minLen ?? 4;
  const t = (text ?? '').trim();
  if (!t) return [];
  // [^...]+[...]+ 抓"非标点 + 标点（可连续）"；末尾可能不带标点的尾段也保留。
  const re = /[^。！？；…!?.\n]+[。！？；…!?.\n]+|[^。！？；…!?.\n]+$/g;
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const s = m[0].replace(/^\s+|\s+$/g, '');
    if (s) raw.push(s);
  }
  if (raw.length === 0) return [t];

  const out: string[] = [];
  for (const s of raw) {
    const last = out.length > 0 ? out[out.length - 1]! : '';
    if (last && last.length < minLen) {
      out[out.length - 1] = last + s;
    } else {
      out.push(s);
    }
  }
  // 最后一句若仍过短，再合并到倒数第二句
  while (out.length >= 2 && out[out.length - 1]!.length < minLen) {
    const last = out.pop()!;
    out[out.length - 1] = out[out.length - 1]! + last;
  }
  return out;
}
