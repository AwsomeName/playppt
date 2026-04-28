import { useEffect, useRef, useState } from 'react';

import { apiNarrationEvent, type SessionPayload } from './api.js';

export type TtsUi = 'client' | 'server';

/**
 * 将讲解词 TTS 与 FSM 事件对齐。自动模式 TTS 完成后为 auto_advance，本地倒计时后发 COUNTDOWN_END。
 */
export function useNarration(
  session: SessionPayload | null,
  onRefresh: (sessionId: string) => void | Promise<void>,
) {
  const [ttsUi, setTtsUi] = useState<TtsUi>('client');
  const [countLeft, setCountLeft] = useState<number | null>(null);
  const playGenRef = useRef(0);
  const oaRef = useRef<HTMLAudioElement | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const runRefresh = (id: string) => {
    void Promise.resolve(onRefreshRef.current(id));
  };

  const sid = session?.sessionId;
  const page = session?.currentPage ?? 0;
  const script =
    session && page >= 1 ? session.pagesData[page - 1]?.script ?? '' : '';
  const sub = session?.subState;
  const top = session?.topState;
  const ttsOn = session?.narrationTtsEnabled !== false;
  const hint = session?.ttsBackend ?? 'client';
  const countdownSec = session?.autoCountdownSec ?? 3;

  const cancelPlayback = () => {
    if (oaRef.current) {
      oaRef.current.pause();
      oaRef.current.src = '';
      oaRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  /* 讲解：仅 presenting + narrating */
  useEffect(() => {
    if (typeof window === 'undefined' || !sid || !ttsOn) return;

    if (top !== 'presenting' || sub !== 'narrating' || !script) {
      playGenRef.current += 1;
      cancelPlayback();
      return;
    }

    if (ttsUi === 'server' && (hint === 'openai' || hint === 'volc')) {
      const cur = oaRef.current;
      if (cur && !cur.ended) {
        return;
      }
    } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        return;
      }
    }

    const gen = (playGenRef.current += 1);

    const send = async (ev: 'TTS_DONE' | 'TTS_FAILED') => {
      if (playGenRef.current !== gen) return;
      await apiNarrationEvent(sid, ev).catch(() => {});
      if (playGenRef.current === gen) runRefresh(sid);
    };

    if (ttsUi === 'server' && (hint === 'openai' || hint === 'volc')) {
      const a = new Audio();
      a.crossOrigin = 'anonymous';
      oaRef.current = a;
      a.onerror = () => {
        oaRef.current = null;
        if (playGenRef.current === gen) void send('TTS_FAILED');
      };
      a.onended = () => {
        oaRef.current = null;
        if (playGenRef.current === gen) void send('TTS_DONE');
      };
      a.src = `/api/session/${encodeURIComponent(sid)}/tts-audio`;
      a.play().catch(() => {
        oaRef.current = null;
        if (playGenRef.current === gen) void send('TTS_FAILED');
      });
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

    return () => {
      playGenRef.current += 1;
      cancelPlayback();
    };
  }, [hint, page, script, sid, sub, top, ttsOn, ttsUi]);

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

  return { ttsUi, setTtsUi, countLeft, ttsOn, hint };
}
