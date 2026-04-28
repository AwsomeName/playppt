export type CommandAction = 'start' | 'next' | 'prev' | 'goto' | 'pause' | 'resume' | 'stop';

export type ChapterHint = { id: string; title: string; startPage: number };

export type ParsedIntent =
  | { kind: 'command'; action: CommandAction; page?: number; match: string }
  | { kind: 'ask'; text: string }
  | { kind: 'noop'; reason: string };

const n = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function clampPg(x: number, min: number, max: number) {
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.trunc(x)));
}

function parseCnOrDigits(tok: string): number {
  const t = n(tok);
  if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
  const one: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (t.length === 1 && t[0]! in one) return one[t[0]!] ?? NaN;
  if (t === '两' || t === '俩') return 2;
  if (t.length === 2 && t[0] === '十' && t[1]! in one) return 10 + (one[t[1]!] ?? 0);
  if (t.length === 2 && t[1] === '十' && t[0]! in one) return (one[t[0]!] ?? 0) * 10;
  if (t.length === 3 && t[0]! in one && t[1] === '十' && t[2]! in one) {
    return (one[t[0]!]! + 0) * 10 + (one[t[2]!]! ?? 0) + 0; // 二十三
  }
  return Number.NaN;
}

/**
 * 1.1.5 有穷集命令；1.1.6 有 chapters 时才可解析为 goto(章首)。
 * 非命令时视为 `ask`。
 */
export function parseUserIntent(
  text: string,
  ctx: { totalPages: number; hasChapters: boolean; chapters?: ChapterHint[] },
): ParsedIntent {
  const t = n(text);
  if (!t) return { kind: 'noop', reason: '空文本' };

  if (t === 'start' || t.startsWith('开始') || t.includes('开讲') || t.includes('启动') || t === '开讲吧') {
    if (!/不(开始|讲)/.test(t)) {
      return { kind: 'command', action: 'start', match: '开始' };
    }
  }
  if (t === 'next' || t.includes('下一') || t.includes('下张') || t === '下页' || t.includes('往后') || t.includes('往后翻')) {
    if (!/不要下一|不下一|不是下一/.test(t)) {
      return { kind: 'command', action: 'next', match: '下一' };
    }
  }
  if (t.includes('上一') || t === '上一页' || t.includes('往回') || t === 'prev' || t === 'previous') {
    if (!/不要上/.test(t)) {
      return { kind: 'command', action: 'prev', match: '上一' };
    }
  }
  if (t.includes('暂停') || t === '停一下' || t === 'pause' || t.includes('别讲了') || t.includes('别播了')) {
    if (!/不暂停/.test(t)) {
      return { kind: 'command', action: 'pause', match: '暂停' };
    }
  }
  if ((t.includes('继续') && !t.includes('不继续')) || t === 'resume' || t === 'go on') {
    if (t.length < 20) {
      return { kind: 'command', action: 'resume', match: '继续' };
    }
  }
  if (
    t === 'stop' ||
    t === '结束' ||
    t === '不讲了' ||
    t === '不玩了' ||
    (t.includes('结束') && t.length < 8) ||
    (t.includes('停止') && t.length < 8)
  ) {
    if (!/不(结束|停)/.test(t)) {
      return { kind: 'command', action: 'stop', match: '结束' };
    }
  }
  if (t === '停' && t.length < 3) {
    return { kind: 'command', action: 'stop', match: '停' };
  }
  if (t.includes('最后') && (t.includes('页') || t.includes('张') || t.includes('一'))) {
    if (/(^|。|\s|到|去|来)(到|去|来)?(最后|末|尾)/.test(t) || t.includes('最后一') || t.includes('尾页')) {
      if (!/第一/.test(t) || t.includes('最后') || t.includes('尾')) {
        if (!/不是最/.test(t)) {
          return {
            kind: 'command',
            action: 'goto',
            page: ctx.totalPages,
            match: '最后页',
          };
        }
      }
    }
  }
  if (/(^|。|\s|到|去|来)(第?一|首)(页|张)?$/.test(t) || t === '第一' || t === '第一页' || t === '到第一页' || t === '首页' || t === '去第一页' || t === '去第一') {
    if (!/最[后末]/.test(t) && !/不(到|要)/.test(t)) {
      return { kind: 'command', action: 'goto', page: 1, match: '第一页' };
    }
  }

  if (ctx.hasChapters && ctx.chapters?.length) {
    for (const ch of ctx.chapters) {
      const chId = n(ch.id);
      const chT = n(ch.title);
      if (t.includes(chId) || t.includes(chT)) {
        if (/(到|去|来|看|看第|到第|进入)/.test(t) || t.includes('章')) {
          return {
            kind: 'command',
            action: 'goto',
            page: clampPg(ch.startPage, 1, ctx.totalPages),
            match: '章节',
          };
        }
      }
    }
  }

  const m = t.match(
    /(到|去|来|看|转|切)\s*第?\s*([0-9两一二三四五六七八九十两]+)\s*页/,
  );
  if (m) {
    const p0 = /^\d+$/.test(m[2]!) ? parseInt(m[2]!, 10) : parseCnOrDigits(m[2]!);
    if (Number.isFinite(p0)) {
      return {
        kind: 'command',
        action: 'goto',
        page: clampPg(p0, 1, ctx.totalPages),
        match: '到第N页',
      };
    }
  }
  const m2 = t.match(/第\s*([0-9两一二三四五六七八九十两]+)\s*页/);
  if (m2) {
    const p0 = /^\d+$/.test(m2[1]!) ? parseInt(m2[1]!, 10) : parseCnOrDigits(m2[1]!);
    if (Number.isFinite(p0)) {
      return { kind: 'command', action: 'goto', page: clampPg(p0, 1, ctx.totalPages), match: '第N页' };
    }
  }

  if (t === 'next' || t === 'n') {
    return { kind: 'command', action: 'next', match: 'next' };
  }

  return { kind: 'ask', text };
}
