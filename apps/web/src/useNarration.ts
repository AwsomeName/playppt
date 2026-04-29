import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGetTtsSentences, apiNarrationEvent, type SessionPayload } from './api.js';

export type TtsUi = 'client' | 'server';

export interface UseNarrationOptions {
  /**
   * 期望的扬声器输出设备（来自 enumerateDevices）。仅 HTML Audio（即 ttsUi='server' 路径）能通过
   * `setSinkId` 路由到指定输出；浏览器内置 SpeechSynthesis 不支持选择输出。
   * 选了非空 outputDeviceId 时会**自动切到 ttsUi='server'**，否则蓝牙/外接音箱场景无法生效。
   */
  outputDeviceId?: string;
  /**
   * 服务端 Volc TTS 音色（speaker_id），如 `zh_male_jingyangboshi_bigtts`。
   * 不传时使用服务端默认（local.properties / .env 的 VOLC_TTS_SPEAKER）。
   */
  speaker?: string;
  /**
   * 进入"narrating"状态后的入场延时（ms）。**翻页/暂停恢复后留 1.5s 缓冲**再开口，
   * 让画面切换、观众视线对齐之后再播报，避免突兀。
   * 设 0 关闭。默认 1500ms。
   */
  leadInMs?: number;
}

/**
 * 将讲解词 TTS 与 FSM 事件对齐。自动模式 TTS 完成后为 auto_advance，本地倒计时后发 COUNTDOWN_END。
 */
export function useNarration(
  session: SessionPayload | null,
  onRefresh: (sessionId: string) => void | Promise<void>,
  options: UseNarrationOptions = {},
) {
  const { outputDeviceId = '', speaker = '', leadInMs = 1500 } = options;
  const [ttsUi, setTtsUi] = useState<TtsUi>('client');
  const [countLeft, setCountLeft] = useState<number | null>(null);
  const playGenRef = useRef(0);
  const oaRef = useRef<HTMLAudioElement | null>(null);
  /** 逐句队列：句间 / lead-in 都用 setTimeout 留停顿，cancelPlayback 时一起清。 */
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const outputDeviceIdRef = useRef(outputDeviceId);
  outputDeviceIdRef.current = outputDeviceId;
  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  /** 保存当前 gen 已经 fallback 过 SpeechSynthesis 的标记，避免 audio.onerror + play().catch 都触发
   *  导致第二次 speechSynthesis.cancel() 把第一次 utterance 干掉，整段无声。 */
  const fallenBackGenRef = useRef<number>(-1);
  /** 记录服务端 TTS 拒绝过的 speaker_id（500 等），下次自动跳过，回退到服务端默认音色。
   *  常见原因：用户的 VOLC_TTS_RESOURCE_ID 是普通 TTS，但选的是大模型 speaker（或反之）。 */
  const badSpeakersRef = useRef<Set<string>>(new Set());

  /** 句间停顿（毫秒）。280ms 大致与人讲话句末换气节奏接近。 */
  const SENTENCE_PAUSE_MS = 280;

  const runRefresh = (id: string) => {
    void Promise.resolve(onRefreshRef.current(id));
  };

  const sid = session?.sessionId;
  const page = session?.currentPage ?? 0;
  const sub = session?.subState;
  const top = session?.topState;
  const ttsOn = session?.narrationTtsEnabled !== false;
  const hint = session?.ttsBackend ?? 'client';
  const countdownSec = session?.autoCountdownSec ?? 3;

  let script: string;
  if (sub === 'opening_narrating') {
    script = session?.opening ?? '';
  } else if (sub === 'closing_narrating') {
    script = session?.closing ?? '';
  } else {
    script = session && page >= 1 ? session.pagesData[page - 1]?.script ?? '' : '';
  }

  // 选了具体输出设备时强制走服务端 TTS（HTML Audio 才能 setSinkId）。
  useEffect(() => {
    if (outputDeviceId && ttsUi !== 'server') {
      setTtsUi('server');
    }
  }, [outputDeviceId, ttsUi]);

  // 后端可用 TTS（volc/openai）时，默认就走 server——浏览器 SpeechSynthesis 在 macOS Chrome
  // 上中文 voice 经常缺席（speak() 不报错也不出声），整段静音；服务端 TTS 至少能稳定生成 mp3。
  // autoplay policy 拦截 audio.play() 时由 fallbackToSpeech() 兜底（先尝试 SpeechSynthesis，
  // 它若也无声会触发 onerror → TTS_FAILED → FSM 进入 waiting_confirm），用户体验比"什么都听不到
  // 还以为正常运行"明显更好。仅在 hint 首次确定时切换，避免反复来回切。
  const hintRef = useRef<typeof hint | null>(null);
  useEffect(() => {
    if (!hint || hintRef.current === hint) return;
    hintRef.current = hint;
    if ((hint === 'volc' || hint === 'openai') && ttsUi !== 'server') {
      setTtsUi('server');
    }
  }, [hint, ttsUi]);

  const cancelPlayback = () => {
    if (pendingTimerRef.current != null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    const a = oaRef.current;
    if (a) {
      // 重要：必须先把回调清掉，否则 a.load() 会触发 'emptied'/'error'，导致旧 gen 的 onerror 重新跑，
      // 进而对当前 sid 误发 TTS_FAILED 把 FSM 拉走。
      a.onerror = null;
      a.onended = null;
      a.onloadeddata = null;
      try { a.pause(); } catch { /* ignore */ }
      try { a.removeAttribute('src'); } catch { /* ignore */ }
      // 关键：仅 a.src='' 不会丢弃已经缓冲的音频，浏览器会把 buffer 里的剩余音频播完。
      // a.load() 强制 reset 媒体管线，立即停下播放。
      try { a.load(); } catch { /* ignore */ }
      oaRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  };

  /**
   * Barge-in：用户开口插话时立即取消当前 TTS，递增 gen 阻断旧 onend/onerror 回灌 FSM。
   * 仅作用于"当前一次"播放：FSM 推进到下一段（QUESTION_DETECTED/NEXT 等）时 effect 会重新跑。
   */
  const interrupt = useCallback(() => {
    playGenRef.current += 1;
    cancelPlayback();
  }, []);

  /* 讲解：仅 presenting + narrating */
  useEffect(() => {
    if (typeof window === 'undefined' || !sid || !ttsOn) return;

    if (top !== 'presenting' || (sub !== 'narrating' && sub !== 'opening_narrating' && sub !== 'closing_narrating') || !script) {
      playGenRef.current += 1;
      cancelPlayback();
      return;
    }

    // Cancel any previous playback before starting new one
    cancelPlayback();
    playGenRef.current += 1;

    const gen = playGenRef.current;

    const send = async (ev: 'TTS_DONE' | 'TTS_FAILED') => {
      if (playGenRef.current !== gen) return;
      await apiNarrationEvent(sid, ev).catch(() => {});
      if (playGenRef.current === gen) runRefresh(sid);
    };

    /** 服务端 TTS 出错（autoplay 拦截 / 加载失败 / 音色不支持 / 网络）时回退到浏览器内置 TTS。
     *  不直接 send('TTS_FAILED')——那会把 FSM 拉到 waiting_confirm，整段就废了。
     *  幂等：audio 同一次失败可能同时触发 onerror + play().catch，必须避免第二次 cancel
     *  把第一次 speak 出去的 utterance 干掉。 */
    const fallbackToSpeech = (reason: string) => {
      if (playGenRef.current !== gen) return;
      if (fallenBackGenRef.current === gen) return;
      fallenBackGenRef.current = gen;
      console.warn('[useNarration] server TTS failed, fallback to SpeechSynthesis:', reason);
      // 把当前 speaker 标记为坏：下次合成自动跳过，回到服务端默认音色（避免反复失败）。
      // 服务端 500 / NotSupportedError 在前端 audio 层都只看到 onerror code=4 + play() reject，
      // 难以区分是音色不被支持还是网络瞬抖；保守地把当前 speaker 标记为坏，回退默认音色更稳。
      const sp = speakerRef.current;
      if (sp) badSpeakersRef.current.add(sp);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
        const u = new SpeechSynthesisUtterance(script);
        u.lang = 'zh-CN';
        u.onend = () => { if (playGenRef.current === gen) void send('TTS_DONE'); };
        u.onerror = () => { if (playGenRef.current === gen) void send('TTS_FAILED'); };
        window.speechSynthesis.speak(u);
      } else {
        void send('TTS_FAILED');
      }
    };

    /** 真正启动播放（不含 lead-in 延时）。 */
    const startPlayback = () => {
      if (playGenRef.current !== gen) return;
      if (ttsUi === 'server' && (hint === 'openai' || hint === 'volc')) {
        // 逐句播放：先取分句列表，依次创建 <audio> 加载第 N 句，结束后 setTimeout 留停顿再放下一句。
        // 任一环节出错 → TTS_FAILED；全部播完 → TTS_DONE；中途 cancelPlayback 通过 playGenRef gen 短路。
        void (async () => {
          let sentences: string[] = [];
          try {
            const r = await apiGetTtsSentences(sid);
            sentences = r.sentences;
          } catch {
            // 分句接口不可用时降级为整段播放，避免单点故障阻断 TTS。
            sentences = [];
          }
          if (playGenRef.current !== gen) return;
          if (sentences.length === 0) sentences = [script];

          let i = 0;

          const setSink = (a: HTMLAudioElement) => {
            const did = outputDeviceIdRef.current;
            if (!did) return;
            const setSinkId = (a as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId;
            if (typeof setSinkId !== 'function') return;
            try {
              void setSinkId.call(a, did).catch(() => {});
            } catch {
              /* ignore */
            }
          };

          const playOne = () => {
            if (playGenRef.current !== gen) return;
            if (i >= sentences.length) {
              void send('TTS_DONE');
              return;
            }
            const a = new Audio();
            a.crossOrigin = 'anonymous';
            oaRef.current = a;
            a.onerror = () => {
              oaRef.current = null;
              // 加载/解码失败 → 回退浏览器 TTS，不要把 FSM 拉到 waiting_confirm
              fallbackToSpeech(`audio.onerror (i=${i}, code=${a.error?.code ?? '?'})`);
            };
            a.onended = () => {
              oaRef.current = null;
              if (playGenRef.current !== gen) return;
              i += 1;
              if (i >= sentences.length) {
                void send('TTS_DONE');
                return;
              }
              // 句间留停顿（用 setTimeout 而不是 silence mp3：客户端控制节奏更灵活，取消也好做）
              pendingTimerRef.current = setTimeout(() => {
                pendingTimerRef.current = null;
                playOne();
              }, SENTENCE_PAUSE_MS);
            };
            // ?sentence=N 让后端只合成第 i 句；?speaker=xxx 覆盖默认音色（local.properties 里的 VOLC_TTS_SPEAKER）。
            // 已被服务端拒绝过的 speaker_id 自动跳过，回退到服务端默认音色——避免用户选了与 VOLC_TTS_RESOURCE_ID
            // 不兼容的音色（普通 TTS vs 大模型 TTS speaker 不通用）后整段反复 500 无声。
            const params = new URLSearchParams();
            params.set('sentence', String(i));
            const sp = speakerRef.current;
            if (sp && !badSpeakersRef.current.has(sp)) params.set('speaker', sp);
            a.src = `/api/session/${encodeURIComponent(sid)}/tts-audio?${params.toString()}`;
            setSink(a);
            a.play().catch((err: unknown) => {
              oaRef.current = null;
              // 最常见：autoplay policy 拒绝（首次进入 PlayPage 没有 user gesture）。
              // 其它：媒体加载失败、speaker 不被服务端识别等。统一回退浏览器 TTS。
              const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
              fallbackToSpeech(`audio.play rejected (${msg})`);
            });
          };

          playOne();
        })();
      } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(script);
        u.lang = 'zh-CN';
        u.onend = () => {
          if (playGenRef.current === gen) void send('TTS_DONE');
        };
        u.onerror = () => {
          if (playGenRef.current === gen) void send('TTS_FAILED');
        };
        window.speechSynthesis.speak(u);
      } else {
        void send('TTS_FAILED');
      }
    };

    // Lead-in：每次进入 narrating（翻页 / 暂停恢复 / 自动倒计时结束）都先停顿一会儿再开口，
    // 让画面切换 / 观众视线对齐之后再播报，避免突兀。
    if (leadInMs > 0) {
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        startPlayback();
      }, leadInMs);
    } else {
      startPlayback();
    }

    return () => {
      playGenRef.current += 1;
      cancelPlayback();
    };
  }, [hint, leadInMs, page, script, sid, sub, top, ttsOn, ttsUi]);

  useEffect(() => {
    if (!sid || !ttsOn) {
      setCountLeft(null);
      return;
    }
    if (sub !== 'auto_advance' || top !== 'presenting') {
      setCountLeft(null);
      return;
    }
    setCountLeft(countdownSec);
    let left = countdownSec;
    const t = setInterval(() => {
      left -= 1;
      setCountLeft((x) => (x != null && x > 0 ? x - 1 : 0));
      if (left <= 0) {
        clearInterval(t);
        setCountLeft(null);
        void apiNarrationEvent(sid, 'COUNTDOWN_END')
          .catch(() => {})
          .then(() => {
            if (typeof sid === 'string') runRefresh(sid);
          });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [countdownSec, sid, sub, top, ttsOn]);

  return { ttsUi, setTtsUi, countLeft, ttsOn, hint, interrupt };
}
