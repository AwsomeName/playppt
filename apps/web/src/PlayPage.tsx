import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  apiGetSession,
  apiPostControl,
  apiPatchSession,
  apiPatchMode,
  apiPostInterpret,
  apiPostInterruptAsk,
  type SessionPayload,
  type AskResponse,
  type VoicePipelineResult,
} from './api.js';
import { useAudioDevices } from './useAudioDevices.js';
import { useNarration } from './useNarration.js';
import { useVoiceWake } from './useVoiceWake.js';
import { useRealtimeInterrupt } from './useRealtimeInterrupt.js';
import { VoicePanel } from './VoicePanel.js';
import { PlayControls } from './PlayControls.js';
import { SlideImageView } from './SlideImageView.js';
import { ChatPanel, type ChatMessage } from './ChatPanel.js';
import { VOLC_TTS_SPEAKERS } from './ttsSpeakers.js';

const LS_HARDWARE_AEC = 'play-ppt:audio:hardwareAec';
const LS_TTS_SPEAKER = 'play-ppt:tts:speaker';

/** localStorage 存的音色 ID 不在当前清单（例如清单从豆包 1.0 升级到 2.0、后缀从 saturn 变 uranus）
 *  时丢弃，回退到服务端默认音色——避免老用户被旧 ID 卡住反复 55000000 mismatch。 */
function readPersistedSpeaker(): string {
  if (typeof window === 'undefined') return '';
  try {
    const v = window.localStorage.getItem(LS_TTS_SPEAKER) ?? '';
    if (!v) return '';
    if (VOLC_TTS_SPEAKERS.some((s) => s.id === v)) return v;
    window.localStorage.removeItem(LS_TTS_SPEAKER);
    return '';
  } catch {
    return '';
  }
}

type QaState = 'idle' | 'thinking' | 'answered';

function makeMsgId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function summarizePipelineForChat(r: VoicePipelineResult): { role: 'assistant' | 'system'; text: string; meta: ChatMessage['meta'] } {
  if (r.kind === 'control') {
    return {
      role: 'system',
      text: `命令已执行：${r.result.state}（第 ${r.result.currentPage} 页）`,
      meta: { kind: 'control' },
    };
  }
  if (r.kind === 'answered') {
    return {
      role: 'assistant',
      text: r.ask.answerText,
      meta: {
        kind: 'answered',
        sourcePages: r.ask.sourcePages,
        confidence: r.ask.confidence,
        fallbackMode: r.ask.fallbackMode,
      },
    };
  }
  if (r.kind === 'suggest_ask') {
    return {
      role: 'system',
      text: `未能在当前状态自动作答：${r.message}`,
      meta: { kind: 'suggest_ask' },
    };
  }
  if (r.kind === 'ignored') {
    return {
      role: 'system',
      text: `识别到口语「${r.transcript.slice(0, 40)}${r.transcript.length > 40 ? '…' : ''}」但判定与 PPT 无关，已忽略（${r.reason}）。`,
      meta: { kind: 'note' },
    };
  }
  return {
    role: 'system',
    text: `请求被拒绝：${r.message}`,
    meta: { kind: 'rejected' },
  };
}

export function PlayPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [err, setErr] = useState<{ message: string } | null>(null);
  const [showVoice, setShowVoice] = useState(false);
  const [showAskInput, setShowAskInput] = useState(false);
  const [askText, setAskText] = useState('');
  const [qaResult, setQaResult] = useState<AskResponse | null>(null);
  const [qaState, setQaState] = useState<QaState>('idle');
  const [qaError, setQaError] = useState<string | null>(null);
  const hasStartedRef = useRef(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);

  const audioDevices = useAudioDevices();
  const [hardwareAec, setHardwareAec] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(LS_HARDWARE_AEC) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_HARDWARE_AEC, hardwareAec ? '1' : '0');
    } catch { /* ignore */ }
  }, [hardwareAec]);

  // TTS 音色：空字符串 = 用服务端默认（local.properties 里的 VOLC_TTS_SPEAKER）。
  const [ttsSpeaker, setTtsSpeaker] = useState<string>(() => readPersistedSpeaker());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_TTS_SPEAKER, ttsSpeaker);
    } catch { /* ignore */ }
  }, [ttsSpeaker]);

  const appendChat = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'> & { timestamp?: number }) => {
    setChatMessages((prev) => [
      ...prev,
      { id: makeMsgId(), timestamp: msg.timestamp ?? Date.now(), ...msg },
    ]);
  }, []);

  // 语音唤醒监听开关
  const [voiceWakeEnabled, setVoiceWakeEnabled] = useState(false);
  const refreshRef = useRef<(sid: string) => Promise<void>>(async () => {});
  const voiceWakeState = useVoiceWake({
    sessionId: sessionId ?? '',
    enabled: voiceWakeEnabled && !!sessionId && session?.topState === 'presenting',
    onStateRefresh: useCallback(() => {
      if (sessionId) void refreshRef.current(sessionId);
    }, [sessionId]),
  });

  const refresh = useCallback(async (sid: string) => {
    setErr(null);
    try {
      const s = await apiGetSession(sid);
      setSession(s);
      // When FSM exits qa state, clear local qa overlay
      if (s.topState !== 'qa') {
        setQaResult(null);
        setQaState('idle');
        setQaError(null);
      }
    } catch (e) {
      setSession(null);
      const msg = e instanceof Error ? e.message : String(e);
      setErr({ message: msg });
      // Session not found (server restarted, session expired) — auto redirect
      if (msg.includes('不存在') || msg.includes('已清理') || msg.includes('404')) {
        navigate('/', { replace: true });
      }
    }
  }, [navigate]);

  // 更新 refresh ref 供语音唤醒使用
  refreshRef.current = refresh;

  const { countLeft, interrupt: interruptNarration, ttsUi, setTtsUi, hint: ttsHint } = useNarration(session, refresh, {
    outputDeviceId: audioDevices.outputId,
    speaker: ttsSpeaker,
  });

  // 当前 TTS 是否在出声：TTS 出声时 VAD 阈值收紧（防自激回授）
  const ttsActuallyPlaying =
    !!session
    && session.topState === 'presenting'
    && session.subState === 'narrating'
    && session.narrationTtsEnabled !== false;

  // 实时打断：VAD 起点仅作录音触发，是否打断 TTS 由 onResult 内根据 result.kind 决定。
  const realtime = useRealtimeInterrupt({
    sessionId: sessionId ?? '',
    enabled: realtimeEnabled && !!sessionId,
    topState: session?.topState,
    ttsPlaying: ttsActuallyPlaying,
    inputDeviceId: audioDevices.inputId,
    hardwareAec,
    onResult: useCallback(({ transcript, result }: { transcript: string; result: VoicePipelineResult }) => {
      // 1) 识别为命令或问答 → 写入对话历史 + 立刻打断 TTS（让用户感知到"被听到了"）
      // 2) ignored / rejected / suggest_ask → 不打断，TTS 继续；ignored 仅留一条淡色"已忽略"提示
      const shouldInterrupt = result.kind === 'control' || result.kind === 'answered';

      if (result.kind === 'control' || result.kind === 'answered' || result.kind === 'suggest_ask' || result.kind === 'rejected') {
        if (transcript.trim()) {
          appendChat({ role: 'user', text: transcript });
        }
      }
      const summary = summarizePipelineForChat(result);
      appendChat({ role: summary.role, text: summary.text, meta: summary.meta });

      if (shouldInterrupt) {
        interruptNarration();
        try {
          if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
        } catch { /* ignore */ }
      }

      if (result.kind === 'answered') {
        try {
          if (typeof window !== 'undefined' && window.speechSynthesis) {
            const u = new SpeechSynthesisUtterance(result.ask.answerText);
            u.lang = 'zh-CN';
            window.speechSynthesis.speak(u);
          }
        } catch { /* ignore */ }
      }

      if (sessionId) void refresh(sessionId);
    }, [appendChat, interruptNarration, refresh, sessionId]),
    onError: useCallback((msg: string) => {
      appendChat({ role: 'system', text: `实时打断错误：${msg}`, meta: { kind: 'rejected' } });
    }, [appendChat]),
  });

  useEffect(() => {
    if (!sessionId) return;
    void refresh(sessionId);
  }, [sessionId, refresh]);

  // Auto-start when session is in idle state (only once)
  useEffect(() => {
    if (!sessionId || !session || session.topState !== 'idle' || hasStartedRef.current) return;
    hasStartedRef.current = true;
    void apiPostControl({ sessionId, action: 'start' }).then(() => void refresh(sessionId));
    // refresh is stable (useCallback with empty deps), but included to satisfy lint
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session, session?.topState]);

  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => {
      void refresh(sessionId);
    }, 1000);
    return () => clearInterval(t);
  }, [sessionId, refresh]);

  const ctrl = async (action: 'start' | 'next' | 'prev' | 'goto' | 'pause' | 'resume' | 'stop', page?: number) => {
    if (!session || !sessionId) return;
    await apiPostControl({ sessionId, action, page: action === 'goto' ? page : undefined });
    await refresh(sessionId);
  };

  // 使用 ref 存储 ctrl 函数，避免键盘事件 effect 频繁重新绑定
  const ctrlRef = useRef(ctrl);
  ctrlRef.current = ctrl;

  // 键盘快捷键：? 或 / 打开提问框，Escape 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 提问快捷键
      if ((e.key === '?' || e.key === '/') && !showAskInput && session?.topState === 'presenting') {
        e.preventDefault();
        setShowAskInput(true);
        return;
      }
      // Escape 关闭提问框
      if (e.key === 'Escape' && showAskInput) {
        setShowAskInput(false);
        setAskText('');
        return;
      }
      // 空格键暂停/继续（当不在输入框时）
      if (e.key === ' ' && !showAskInput && !showVoice) {
        e.preventDefault();
        if (session?.topState === 'presenting') {
          void ctrlRef.current('pause');
        } else if (session?.topState === 'paused') {
          void ctrlRef.current('resume');
        }
        return;
      }
      // 方向键翻页
      if (!showAskInput && !showVoice) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          void ctrlRef.current('next');
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          void ctrlRef.current('prev');
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session?.topState, showAskInput, showVoice]);

  const clearFallback = async () => {
    if (!session || !sessionId) return;
    await apiPatchSession(sessionId, { clearFallback: true });
    await refresh(sessionId);
  };

  const switchMode = async () => {
    if (!session || !sessionId) return;
    const newMode = session.advanceModeEffective === 'auto' ? 'manual' : 'auto';
    await apiPatchMode(sessionId, newMode);
    await refresh(sessionId);
  };

  const submitQuestion = async () => {
    if (!session || !sessionId || !askText.trim()) return;
    setQaState('thinking');
    setQaError(null);
    setQaResult(null);
    setShowAskInput(false);
    try {
      // 使用 interrupt-ask 一键完成暂停->提问->恢复流程
      const r = await apiPostInterruptAsk(sessionId, { question: askText.trim(), currentPage: session.currentPage });
      setQaResult(r);
      setQaState('answered');
      // Speak the answer via browser SpeechSynthesis
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          const u = new SpeechSynthesisUtterance(r.answerText);
          u.lang = 'zh-CN';
          window.speechSynthesis.speak(u);
        }
      } catch { /* ignore */ }
      setAskText('');
      await refresh(sessionId);
    } catch (e) {
      setQaState('idle');
      setQaError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 对话面板文本提交（显式意图）：命令优先；非命令直接走 ask（**跳过 LLM 意图分类**），
   * 避免分类器把用户主动输入的"今天天气如何"等也忽略掉。
   */
  const submitChatText = useCallback(async (text: string) => {
    if (!sessionId) return;
    appendChat({ role: 'user', text });
    interruptNarration();
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch { /* ignore */ }
    try {
      const it = await apiPostInterpret(sessionId, text);
      if (it.kind === 'control') {
        appendChat({
          role: 'system',
          text: `命令已执行：${it.result.state}（第 ${it.result.currentPage} 页）`,
          meta: { kind: 'control' },
        });
        await refresh(sessionId);
        return;
      }
      // 非命令：直接 ask（不再分类）。问答需要 presenting/qa；其它态给提示。
      if (!session) return;
      if (session.topState !== 'presenting' && session.topState !== 'qa') {
        appendChat({
          role: 'system',
          text: '当前状态不可问答，请在讲解或问答中提交。',
          meta: { kind: 'suggest_ask' },
        });
        return;
      }
      const r = await apiPostInterruptAsk(sessionId, {
        question: text,
        currentPage: session.currentPage,
      });
      appendChat({
        role: 'assistant',
        text: r.answerText,
        meta: {
          kind: 'answered',
          sourcePages: r.sourcePages,
          confidence: r.confidence,
          fallbackMode: r.fallbackMode,
        },
      });
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          const u = new SpeechSynthesisUtterance(r.answerText);
          u.lang = 'zh-CN';
          window.speechSynthesis.speak(u);
        }
      } catch { /* ignore */ }
      await refresh(sessionId);
    } catch (e) {
      appendChat({
        role: 'system',
        text: `提交失败：${e instanceof Error ? e.message : String(e)}`,
        meta: { kind: 'rejected' },
      });
    }
  }, [appendChat, interruptNarration, refresh, session, sessionId]);

  if (!sessionId) return <div>缺少 sessionId</div>;
  if (err && !session) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#f87171' }}>
        会话加载失败：{err.message}
        <br />
        <button type="button" onClick={() => navigate('/')} style={{ marginTop: '1rem' }}>
          返回管理页
        </button>
      </div>
    );
  }

  const current = session && session.currentPage >= 1
    ? session.pagesData[session.currentPage - 1]
    : null;

  const currentSlideUrl = session?.slideImagesBaseUrl && session?.slideImages && session.currentPage >= 1
    ? `${session.slideImagesBaseUrl}/${session.slideImages[session.currentPage - 1]?.file}`
    : null;

  const canAsk = session && (session.topState === 'presenting' || session.topState === 'qa');

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      {/* Back button */}
      <button
        type="button"
        onClick={() => navigate('/')}
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '0.3rem 0.7rem',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: 13,
          zIndex: 20,
        }}
      >
        &#8592; 返回
      </button>

      {/* Ask question button */}
      {canAsk && (
        <button
          type="button"
          onClick={() => setShowAskInput(!showAskInput)}
          style={{
            position: 'fixed',
            top: 12,
            left: 80,
            background: 'rgba(99,102,241,0.15)',
            border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 6,
            padding: '0.3rem 0.7rem',
            color: '#a5b4fc',
            cursor: 'pointer',
            fontSize: 13,
            zIndex: 20,
          }}
        >
          提问
        </button>
      )}

      {/* Ask input overlay */}
      {showAskInput && (
        <div style={{
          position: 'fixed', top: 44, left: 80,
          background: 'rgba(0,0,0,0.85)',
          borderRadius: 8,
          padding: '0.6rem',
          zIndex: 20,
          width: 280,
        }}>
          <textarea
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            rows={2}
            placeholder="输入你的问题..."
            style={{
              width: '100%',
              maxWidth: '100%',
              boxSizing: 'border-box',
              padding: '0.4rem',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(0,0,0,0.3)',
              color: '#e2e8f0',
              fontSize: 14,
              resize: 'vertical' as const,
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => void submitQuestion()}
              disabled={!askText.trim()}
              style={{
                background: 'rgba(99,102,241,0.2)',
                border: '1px solid rgba(99,102,241,0.35)',
                borderRadius: 4,
                padding: '0.3rem 0.7rem',
                color: askText.trim() ? '#a5b4fc' : '#64748b',
                cursor: askText.trim() ? 'pointer' : 'default',
                fontSize: 13,
              }}
            >
              提交
            </button>
            <button
              type="button"
              onClick={() => { setShowAskInput(false); setAskText(''); }}
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                padding: '0.3rem 0.7rem',
                color: '#94a3b8',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Voice toggle button (legacy panel, 仅作高级调试用，常驻在 ChatPanel 左侧) */}
      <button
        type="button"
        onClick={() => setShowVoice(!showVoice)}
        style={{
          position: 'fixed',
          top: 12,
          right: chatOpen ? 364 : 56,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '0.3rem 0.7rem',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: 13,
          zIndex: 20,
        }}
      >
        {showVoice ? '关闭语音' : '语音调试'}
      </button>

      {/* QA overlay */}
      {(session?.topState === 'qa' || qaState === 'thinking') && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          zIndex: 15,
        }}>
          <div style={{
            background: 'rgba(15,23,42,0.92)',
            borderRadius: 12,
            padding: '1.5rem 2rem',
            maxWidth: 560,
            width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}>
            {qaState === 'thinking' && (
              <div style={{ textAlign: 'center', color: '#94a3b8' }}>
                <div style={{ fontSize: 16, marginBottom: 8 }}>正在检索和生成答案...</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>请稍候</div>
              </div>
            )}
            {qaState === 'answered' && qaResult && (
              <>
                <div style={{ fontSize: 12, color: '#a5b4fc', marginBottom: 8, letterSpacing: '0.05em' }}>
                  问答
                </div>
                <div style={{ color: '#e2e8f0', fontSize: 16, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {qaResult.answerText}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 12, color: '#64748b' }}>
                  {qaResult.sourcePages.length > 0 && (
                    <span>参考页码：{qaResult.sourcePages.join(', ')}</span>
                  )}
                  {qaResult.confidence > 0 && (
                    <span>置信度：{Math.round(qaResult.confidence * 100)}%</span>
                  )}
                  {qaResult.fallbackMode && (
                    <span style={{ color: '#fbbf24' }}>降级模式</span>
                  )}
                </div>
              </>
            )}
            {qaError && (
              <div style={{ color: '#f87171', fontSize: 14 }}>{qaError}</div>
            )}
          </div>
        </div>
      )}

      {/* Idle state: auto-starting */}
      {!session || session.topState === 'idle' ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ color: '#64748b', fontSize: 16 }}>加载中...</div>
        </div>
      ) : session.subState === 'opening_narrating' && session.opening ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column',
        }}>
          <div style={{
            background: 'rgba(15,23,42,0.88)',
            borderRadius: 16,
            padding: '2rem 3rem',
            maxWidth: 700,
            textAlign: 'center',
          }}>
            <h1 style={{ color: '#e2e8f0', fontSize: 32, margin: '0 0 1rem' }}>{session.title}</h1>
            <p style={{ color: '#94a3b8', fontSize: 18, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{session.opening}</p>
            <div style={{ color: '#64748b', fontSize: 13, marginTop: '1rem' }}>开场白播报中...</div>
          </div>
        </div>
      ) : session.subState === 'closing_narrating' && session.closing ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column',
        }}>
          {currentSlideUrl ? (
            <SlideImageView
              url={currentSlideUrl}
              title={current?.title ?? ''}
              fallbackContent={current?.content ?? ''}
              fullscreen
            />
          ) : null}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}>
            <div style={{
              background: 'rgba(15,23,42,0.88)',
              borderRadius: 16,
              padding: '2rem 3rem',
              maxWidth: 700,
              textAlign: 'center',
            }}>
              <p style={{ color: '#94a3b8', fontSize: 18, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{session.closing}</p>
              <div style={{ color: '#64748b', fontSize: 13, marginTop: '1rem' }}>收尾播报中...</div>
            </div>
          </div>
        </div>
      ) : current && currentSlideUrl ? (
        <SlideImageView
          url={currentSlideUrl}
          title={current.title}
          fallbackContent={current.content}
          fullscreen
        />
      ) : current ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '2rem',
        }}>
          <div style={{ textAlign: 'center', maxWidth: 600 }}>
            <h2 style={{ color: '#e2e8f0', fontSize: 28, margin: '0 0 0.5rem' }}>{current.title}</h2>
            <p style={{ color: '#94a3b8', fontSize: 17, lineHeight: 1.6 }}>{current.content}</p>
          </div>
        </div>
      ) : null}

      {/* Countdown overlay */}
      {countLeft != null && countLeft > 0 && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.6)', borderRadius: 20,
          padding: '0.3rem 1rem', color: '#34d399', fontSize: 14, zIndex: 20,
        }}>
          {countLeft}s 后下一页
        </div>
      )}

      {/* End state */}
      {session?.topState === 'end' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '1rem',
        }}>
          <div style={{ color: '#94a3b8', fontSize: 18 }}>讲解已结束</div>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 8,
              padding: '0.6rem 1.5rem',
              color: '#e2e8f0',
              cursor: 'pointer',
            }}
          >
            返回管理页
          </button>
        </div>
      )}

      {/* Play controls bar */}
      {session && session.topState !== 'idle' && session.topState !== 'end' && (
        <PlayControls
          currentPage={session.currentPage}
          totalPages={session.totalPages}
          state={session.state}
          topState={session.topState}
          subState={session.subState}
          mode={session.mode}
          fallbackMode={session.fallbackMode}
          advanceModeEffective={session.advanceModeEffective}
          narrationTtsEnabled={session.narrationTtsEnabled}
          lastError={session.lastError}
          onPrev={() => void ctrl('prev')}
          onNext={() => void ctrl('next')}
          onPause={() => void ctrl('pause')}
          onResume={() => void ctrl('resume')}
          onStop={() => void ctrl('stop')}
          onGoto={(p) => void ctrl('goto', p)}
          onModeSwitch={() => void switchMode()}
          voiceWakeEnabled={voiceWakeEnabled}
          onVoiceWakeToggle={() => setVoiceWakeEnabled((v) => !v)}
          voiceWakeSupported={voiceWakeState.isSupported}
          voiceWakeListening={voiceWakeState.isListening}
        />
      )}

      {/* 语音唤醒状态指示器 */}
      {voiceWakeEnabled && voiceWakeState.isSupported && (
        <div
          style={{
            position: 'fixed',
            top: 50,
            right: chatOpen ? 364 : 56,
            padding: '0.4rem 0.8rem',
            background: voiceWakeState.isListening ? 'rgba(34,197,94,0.2)' : 'rgba(251,191,36,0.2)',
            border: `1px solid ${voiceWakeState.isListening ? 'rgba(34,197,94,0.4)' : 'rgba(251,191,36,0.4)'}`,
            borderRadius: 6,
            color: voiceWakeState.isListening ? '#86efac' : '#fbbf24',
            fontSize: 12,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ fontSize: 10 }}>{voiceWakeState.isListening ? '●' : '○'}</span>
          {voiceWakeState.isListening ? '唤醒词监听中...' : '唤醒词启动中...'}
        </div>
      )}

      {/* 最近识别的唤醒词 */}
      {voiceWakeState.lastWakeWord && (
        <div
          style={{
            position: 'fixed',
            top: 90,
            right: chatOpen ? 364 : 56,
            padding: '0.3rem 0.6rem',
            background: 'rgba(99,102,241,0.25)',
            border: '1px solid rgba(99,102,241,0.4)',
            borderRadius: 6,
            color: '#a5b4fc',
            fontSize: 12,
            zIndex: 20,
          }}
        >
          识别到: 「{voiceWakeState.lastTranscript?.slice(0, 20)}...」
        </div>
      )}

      {/* Fallback clear button */}
      {session?.fallbackMode && (
        <button
          type="button"
          onClick={() => void clearFallback()}
          style={{
            position: 'fixed', bottom: 60, right: chatOpen ? 364 : 12,
            background: 'rgba(251,191,36,0.2)',
            border: '1px solid rgba(251,191,36,0.4)',
            borderRadius: 6,
            padding: '0.3rem 0.7rem',
            color: '#fbbf24',
            cursor: 'pointer',
            fontSize: 12,
            zIndex: 20,
          }}
        >
          清除降级
        </button>
      )}

      {/* Voice panel overlay (legacy 调试) */}
      {showVoice && session && (
        <div style={{
          position: 'fixed', bottom: 50, right: chatOpen ? 364 : 12,
          width: 320,
          background: 'rgba(0,0,0,0.8)',
          borderRadius: 10,
          padding: '0.75rem',
          zIndex: 20,
        }}>
          <VoicePanel
            sessionId={session.sessionId}
            onStateRefresh={() => void refresh(session.sessionId)}
          />
        </div>
      )}

      {/* 常驻对话面板 + 实时打断控制 */}
      {session && (
        <ChatPanel
          open={chatOpen}
          onToggleOpen={() => setChatOpen((v) => !v)}
          messages={chatMessages}
          onClear={() => setChatMessages([])}
          onSubmitText={(t) => void submitChatText(t)}
          submitDisabled={!sessionId}
          realtimeEnabled={realtimeEnabled}
          onToggleRealtime={() => setRealtimeEnabled((v) => !v)}
          realtimeSupported={realtime.supported}
          captureStatus={realtime.status}
          micLevel={realtime.level}
          topState={session.topState}
          subState={session.subState}
          audio={{
            inputs: audioDevices.inputs,
            outputs: audioDevices.outputs,
            inputId: audioDevices.inputId,
            outputId: audioDevices.outputId,
            setInputId: audioDevices.setInputId,
            setOutputId: audioDevices.setOutputId,
            setSinkIdSupported: audioDevices.setSinkIdSupported,
            permissionGranted: audioDevices.permissionGranted,
            requestPermission: audioDevices.requestPermission,
            hardwareAec,
            setHardwareAec,
            speaker: ttsSpeaker,
            setSpeaker: setTtsSpeaker,
            ttsUi,
            setTtsUi,
            ttsBackend: ttsHint,
          }}
        />
      )}
    </div>
  );
}