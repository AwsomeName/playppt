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

  // 开始命令
  if (t === 'start' || t.startsWith('开始') || t.includes('开讲') || t.includes('启动') || t === '开讲吧' || t.includes('从头开始') || t.includes('重新讲')) {
    if (!/不(开始|讲)/.test(t)) {
      return { kind: 'command', action: 'start', match: '开始' };
    }
  }

  // 下一页命令 - 扩展更多说法
  const nextPatterns = ['下一', '下张', '下页', '往后', '向后', '前进', '下一个', '下一章', '下一节', '往下', '往下翻', '往下走'];
  const isNext = t === 'next' || t === 'n' || nextPatterns.some((p) => t.includes(p)) || /^往后?\s*翻?$/.test(t) || /^下一个$/.test(t);
  if (isNext) {
    if (!/不要下一|不下一|不是下一|不要.*下一/.test(t)) {
      return { kind: 'command', action: 'next', match: '下一' };
    }
  }

  // 上一页命令 - 扩展更多说法
  const prevPatterns = ['上一', '上张', '上页', '往前', '向前', '后退', '上一个', '上一章', '上一节', '返回', '退回去', '回退'];
  const isPrev = t === 'prev' || t === 'previous' || t === 'p' || prevPatterns.some((p) => t.includes(p)) || /^往前?\s*翻?$/.test(t) || /^上一个$/.test(t);
  if (isPrev) {
    if (!/不要上|不上.*上一/.test(t)) {
      return { kind: 'command', action: 'prev', match: '上一' };
    }
  }

  // 暂停命令 - 扩展更多说法（打断相关）
  const pausePatterns = ['暂停', '停一下', '等等', '等一下', '别讲了', '别播了', '先停', '打断', '稍等', '缓一缓', '休息一下'];
  const isPause = t === 'pause' || t === 'stop talking' || pausePatterns.some((p) => t.includes(p)) || (t === '停' && t.length < 3);
  if (isPause) {
    if (!/不暂停|不要暂停|别暂停/.test(t)) {
      return { kind: 'command', action: 'pause', match: '暂停' };
    }
  }

  // 继续命令 - 扩展更多说法
  const resumePatterns = ['继续', '恢复', '讲下去', '开始讲', '播放', '接着讲', '接着说', '往下讲', '请继续', '继续播放', '讲解', '讲一讲', '解说', '说说', '介绍一下', '讲讲'];
  const isResume = t === 'resume' || t === 'go on' || t === 'continue' || resumePatterns.some((p) => t.includes(p));
  if (isResume && !t.includes('不继续') && !t.includes('别继续') && t.length < 25) {
    return { kind: 'command', action: 'resume', match: '继续' };
  }

  // 结束命令 - 扩展更多说法
  const stopPatterns = ['结束', '停止', '不讲了', '不玩了', '终止', '完结', '退出', '关闭', '拜拜', '再见'];
  const isStop = t === 'stop' || t === 'quit' || t === 'exit' || stopPatterns.some((p) => t.includes(p));
  if (isStop && t.length < 15) {
    if (!/不(结束|停)|不要.*结束|别.*结束/.test(t)) {
      return { kind: 'command', action: 'stop', match: '结束' };
    }
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

  // 跳转命令 - 扩展更多说法
  // 注意：页码匹配必须明确包含"页"字，避免与"第X章"混淆
  const gotoPrefixes = '(到|去|来|看|转|切|跳|翻|切到|跳到|前往|打开|查看|转向|进入)';
  const m = t.match(
    new RegExp(`${gotoPrefixes}\\s*第?\\s*([0-9两一二三四五六七八九十两]+)\\s*页`),
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
  // 支持 "第5页" 或 "5页" 的说法（必须包含"页"字）
  const m3 = t.match(/^第?\s*([0-9两一二三四五六七八九十两]+)\s*页$/);
  if (m3) {
    const p0 = /^\d+$/.test(m3[1]!) ? parseInt(m3[1]!, 10) : parseCnOrDigits(m3[1]!);
    if (Number.isFinite(p0)) {
      return { kind: 'command', action: 'goto', page: clampPg(p0, 1, ctx.totalPages), match: '第N页' };
    }
  }
  // 支持 "看第X章" 跳转到章首页（仅在 hasChapters 且有章节数据时生效）
  if (ctx.hasChapters && ctx.chapters?.length) {
    // 匹配"第X章"或"去第X章"等说法
    const chMatch = t.match(/(?:到|去|来|看|转|跳)?\s*第\s*([0-9一二三四五六七八九十]+)\s*章/);
    if (chMatch) {
      const chNum = /^\d+$/.test(chMatch[1]!) ? parseInt(chMatch[1]!, 10) : parseCnOrDigits(chMatch[1]!);
      if (Number.isFinite(chNum) && chNum > 0 && chNum <= ctx.chapters.length) {
        const targetCh = ctx.chapters[chNum - 1];
        if (targetCh) {
          return {
            kind: 'command',
            action: 'goto',
            page: clampPg(targetCh.startPage, 1, ctx.totalPages),
            match: '第N章',
          };
        }
      }
    }
  }

  // 快捷单词命令
  if (t === 'next' || t === 'n' || t === '下') {
    return { kind: 'command', action: 'next', match: 'next' };
  }
  if (t === 'prev' || t === 'p' || t === 'back' || t === '上') {
    return { kind: 'command', action: 'prev', match: 'prev' };
  }
  if (t === 'pause' || t === 'stop' || t === 's') {
    return { kind: 'command', action: 'pause', match: 'pause' };
  }

  // 未能识别为命令，返回 ask 类型
  return { kind: 'ask', text };
}
