/**
 * 自激回授（echo）过滤：
 * 当扬声器和麦克风同设备播放/采集时，TTS 朗读的讲稿可能被麦克风录到再被 ASR 识别，
 * 表现为"用户什么都没说，系统却把讲稿的某段当成了用户输入"。
 *
 * 这里给一个轻量启发式：
 * - 标准化 transcript 与正在朗读的 script（去标点、空格、转小写）；
 * - 计算 transcript 中 4-gram 在 script 中的命中比例；
 * - 命中率高于阈值（默认 0.55）即判定为疑似回授。
 *
 * 优点：实现简单、无外部依赖；中文口语识别误差大时仍可命中较多。
 * 局限：用户原话恰好"重复了讲稿大段内容"的情况会被误判（实践中很少发生，且后果只是"忽略"）。
 */

const PUNCT_RE = /[\s，。、,!?！？.；;：:"'""''""\\(\\)（）\\[\\]【】《》<>「」]+/g;

function normalize(s: string): string {
  return s
    .replace(PUNCT_RE, '')
    .toLowerCase()
    .trim();
}

function nGrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i++) {
    out.add(s.slice(i, i + n));
  }
  return out;
}

export interface EchoCheckOptions {
  /** 4-gram 命中比例阈值，默认 0.55 */
  threshold?: number;
  /** transcript 长度过短时跳过（避免"嗯/啊"等被随便误判）。默认 5 字符 */
  minTranscriptLen?: number;
}

export interface EchoCheckResult {
  isEcho: boolean;
  ratio: number;
  threshold: number;
}

/**
 * 判断 transcript 是否极可能来自 reference（如当前页讲稿 / 最近 N 秒的 TTS 输出）。
 * - reference 为空 / transcript 太短：直接返回 isEcho=false
 */
export function checkEchoOverlap(
  transcript: string,
  reference: string,
  opts: EchoCheckOptions = {},
): EchoCheckResult {
  const threshold = opts.threshold ?? 0.55;
  const minLen = opts.minTranscriptLen ?? 5;
  const t = normalize(transcript);
  const r = normalize(reference);
  if (!t || !r || t.length < minLen) {
    return { isEcho: false, ratio: 0, threshold };
  }
  const tGrams = nGrams(t, 4);
  if (tGrams.size === 0) {
    // transcript 比 4 字符还短：直接看子串包含
    const isEcho = r.includes(t);
    return { isEcho, ratio: isEcho ? 1 : 0, threshold };
  }
  let hits = 0;
  for (const g of tGrams) {
    if (r.includes(g)) hits += 1;
  }
  const ratio = hits / tGrams.size;
  return { isEcho: ratio >= threshold, ratio, threshold };
}
