import { useEffect, useRef, useState } from 'react';

import { VOLC_TTS_SPEAKERS } from './ttsSpeakers.js';
import type { AudioDeviceOption } from './useAudioDevices.js';
import type { CaptureStatus } from './useRealtimeInterrupt.js';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  meta?: {
    sourcePages?: number[];
    confidence?: number;
    fallbackMode?: boolean;
    /** 用于命令类反馈（next/prev/...） */
    kind?: 'control' | 'answered' | 'suggest_ask' | 'rejected' | 'note';
  };
}

export interface ChatPanelAudioControls {
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
  inputId: string;
  outputId: string;
  setInputId: (id: string) => void;
  setOutputId: (id: string) => void;
  /** 浏览器是否支持把 HTMLAudioElement 路由到指定输出 */
  setSinkIdSupported: boolean;
  /** 是否已经获得过麦克风授权（决定 enumerateDevices 能否拿到 label） */
  permissionGranted: boolean;
  requestPermission: () => Promise<void> | void;
  /** 硬件回声消除模式：开启后软件层不再做 VAD 收紧 / 滚动短窗 */
  hardwareAec: boolean;
  setHardwareAec: (b: boolean) => void;
  /** TTS 音色（speaker_id）；空字符串表示用服务端默认 */
  speaker: string;
  setSpeaker: (s: string) => void;
  /** 真正在用的 TTS UI 路径：'server' = HTML Audio（speaker 生效），'client' = 浏览器 SpeechSynthesis */
  ttsUi: 'server' | 'client';
  setTtsUi: (m: 'server' | 'client') => void;
  /** 后端 hint：volc / openai → 服务端能合成；client / disabled → 用浏览器内置 */
  ttsBackend: 'volc' | 'openai' | 'client' | 'disabled' | undefined;
}

interface ChatPanelProps {
  open: boolean;
  onToggleOpen: () => void;
  messages: ChatMessage[];
  onClear: () => void;

  /** 文本提交（手动提问） */
  onSubmitText: (text: string) => void;
  submitDisabled?: boolean;

  /** 实时打断状态 */
  realtimeEnabled: boolean;
  onToggleRealtime: () => void;
  realtimeSupported: boolean;
  captureStatus: CaptureStatus;
  /** dBFS，-90 ~ 0 */
  micLevel?: number;

  /** 顶部讲解状态摘要 */
  topState?: string;
  subState?: string | null;

  /** 音频设备选择（蓝牙会议麦/外接音响）：未提供时不渲染齿轮入口 */
  audio?: ChatPanelAudioControls;
}

function statusBadge(s: CaptureStatus): { color: string; bg: string; label: string; dot: string } {
  switch (s) {
    case 'listening':
      return { color: '#86efac', bg: 'rgba(34,197,94,0.18)', label: '聆听中', dot: '#22c55e' };
    case 'recording':
      return { color: '#fca5a5', bg: 'rgba(239,68,68,0.18)', label: '正在记录...', dot: '#ef4444' };
    case 'processing':
      return { color: '#a5b4fc', bg: 'rgba(99,102,241,0.18)', label: '识别 / 思考', dot: '#6366f1' };
    case 'cooldown':
      return { color: '#fbbf24', bg: 'rgba(251,191,36,0.18)', label: '冷却中', dot: '#f59e0b' };
    case 'error':
      return { color: '#f87171', bg: 'rgba(239,68,68,0.18)', label: '麦克风错误', dot: '#ef4444' };
    default:
      return { color: '#94a3b8', bg: 'rgba(148,163,184,0.18)', label: '未启用', dot: '#64748b' };
  }
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function ChatPanel(props: ChatPanelProps) {
  const {
    open,
    onToggleOpen,
    messages,
    onClear,
    onSubmitText,
    submitDisabled,
    realtimeEnabled,
    onToggleRealtime,
    realtimeSupported,
    captureStatus,
    micLevel = -90,
    topState,
    subState,
    audio,
  } = props;

  const [text, setText] = useState('');
  const [audioPanelOpen, setAudioPanelOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  const badge = statusBadge(captureStatus);
  // 把 dBFS 映射成 0-100
  const meterPct = Math.max(0, Math.min(100, ((micLevel + 70) / 70) * 100));

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggleOpen}
        style={{
          position: 'fixed',
          top: '50%',
          right: 12,
          transform: 'translateY(-50%)',
          background: realtimeEnabled ? 'rgba(34,197,94,0.25)' : 'rgba(99,102,241,0.18)',
          border: `1px solid ${realtimeEnabled ? 'rgba(34,197,94,0.45)' : 'rgba(99,102,241,0.4)'}`,
          color: realtimeEnabled ? '#86efac' : '#a5b4fc',
          borderRadius: 6,
          padding: '0.5rem 0.6rem',
          writingMode: 'vertical-rl' as const,
          fontSize: 13,
          letterSpacing: '0.1em',
          cursor: 'pointer',
          zIndex: 25,
        }}
        title="展开对话面板"
      >
        对话
      </button>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmitText(t);
    setText('');
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        bottom: 56,
        width: 340,
        background: 'rgba(15,23,42,0.92)',
        border: '1px solid rgba(99,102,241,0.25)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        color: '#e2e8f0',
        backdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0.55rem 0.7rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: '0.05em' }}>对话</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#64748b' }}>
          {topState ?? '—'}
          {subState ? `·${subState}` : ''}
        </span>
        {audio && (
          <button
            type="button"
            onClick={() => setAudioPanelOpen((v) => !v)}
            style={{
              background: audioPanelOpen ? 'rgba(99,102,241,0.25)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              color: audioPanelOpen ? '#a5b4fc' : '#94a3b8',
              borderRadius: 4,
              padding: '2px 6px',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
            }}
            title="音频设备"
          >
            ⚙
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#94a3b8',
            borderRadius: 4,
            padding: '2px 6px',
            cursor: 'pointer',
            fontSize: 11,
          }}
          title="清空对话历史"
        >
          清空
        </button>
        <button
          type="button"
          onClick={onToggleOpen}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#94a3b8',
            borderRadius: 4,
            padding: '2px 6px',
            cursor: 'pointer',
            fontSize: 11,
          }}
          title="收起"
        >
          收起
        </button>
      </div>

      {audio && audioPanelOpen && (
        <AudioDevicePanel audio={audio} />
      )}

      {/* 实时打断状态条 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0.45rem 0.7rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: realtimeEnabled ? badge.bg : 'rgba(0,0,0,0.2)',
          fontSize: 12,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: realtimeEnabled ? badge.dot : '#475569',
            boxShadow: realtimeEnabled ? `0 0 8px ${badge.dot}` : 'none',
            flexShrink: 0,
          }}
        />
        <span style={{ color: realtimeEnabled ? badge.color : '#94a3b8', minWidth: 70 }}>
          {realtimeEnabled ? badge.label : '实时打断'}
        </span>
        <div
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.08)',
            overflow: 'hidden',
            opacity: realtimeEnabled ? 1 : 0.4,
          }}
        >
          <div
            style={{
              width: `${meterPct}%`,
              height: '100%',
              background: meterPct > 60 ? '#ef4444' : meterPct > 30 ? '#22c55e' : '#64748b',
              transition: 'width 80ms linear',
            }}
          />
        </div>
        <button
          type="button"
          disabled={!realtimeSupported}
          onClick={onToggleRealtime}
          style={{
            background: realtimeEnabled ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)',
            border: `1px solid ${realtimeEnabled ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)'}`,
            color: realtimeEnabled ? '#fca5a5' : '#86efac',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: realtimeSupported ? 'pointer' : 'default',
            fontSize: 11,
            opacity: realtimeSupported ? 1 : 0.5,
          }}
          title={
            realtimeSupported
              ? realtimeEnabled
                ? '关闭实时打断（停止麦克风采集）'
                : '开启实时打断：开口说话即可打断 TTS 并提问'
              : '当前浏览器或环境不支持麦克风采集'
          }
        >
          {realtimeEnabled ? '关闭' : '开启'}
        </button>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0.6rem 0.7rem',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: '#64748b', fontSize: 12, textAlign: 'center', marginTop: '2rem', lineHeight: 1.6 }}>
            还没有对话。
            <br />
            开启「实时打断」后，讲解中开口说话即可打断 TTS 并提问；
            <br />
            或在下方直接输入文字提交。
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} m={m} />
        ))}
      </div>

      {/* Input */}
      <div
        style={{
          padding: '0.5rem 0.6rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          gap: 6,
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="输入问题或命令（Enter 发送，Shift+Enter 换行）"
          rows={2}
          style={{
            flex: 1,
            resize: 'none',
            padding: '0.45rem 0.55rem',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.3)',
            color: '#e2e8f0',
            fontSize: 13,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <button
          type="button"
          disabled={!text.trim() || submitDisabled}
          onClick={submit}
          style={{
            background: 'rgba(99,102,241,0.25)',
            border: '1px solid rgba(99,102,241,0.4)',
            color: text.trim() && !submitDisabled ? '#a5b4fc' : '#475569',
            borderRadius: 6,
            padding: '0 0.7rem',
            cursor: text.trim() && !submitDisabled ? 'pointer' : 'default',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
}

function AudioDevicePanel({ audio }: { audio: ChatPanelAudioControls }) {
  const {
    inputs,
    outputs,
    inputId,
    outputId,
    setInputId,
    setOutputId,
    setSinkIdSupported,
    permissionGranted,
    requestPermission,
    hardwareAec,
    setHardwareAec,
    speaker,
    setSpeaker,
    ttsUi,
    setTtsUi,
    ttsBackend,
  } = audio;

  const speakerLabel = VOLC_TTS_SPEAKERS.find((s) => s.id === speaker)?.label
    ?? (speaker || '使用服务端默认');
  const backendLabel
    = ttsBackend === 'volc' ? '服务端·Volc'
    : ttsBackend === 'openai' ? '服务端·OpenAI'
    : ttsBackend === 'disabled' ? '已禁用'
    : '浏览器内置';
  const speakerActive = ttsUi === 'server' && (ttsBackend === 'volc' || ttsBackend === 'openai');

  return (
    <div
      style={{
        padding: '0.55rem 0.7rem',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.25)',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ color: '#a5b4fc', fontSize: 11, letterSpacing: '0.05em' }}>音频设备</div>

      {!permissionGranted && (
        <div
          style={{
            background: 'rgba(251,191,36,0.12)',
            border: '1px solid rgba(251,191,36,0.3)',
            color: '#fde68a',
            borderRadius: 4,
            padding: '0.35rem 0.5rem',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ flex: 1 }}>未授权麦克风，设备列表只显示编号。</span>
          <button
            type="button"
            onClick={() => { void requestPermission(); }}
            style={{
              background: 'rgba(251,191,36,0.2)',
              border: '1px solid rgba(251,191,36,0.4)',
              color: '#fbbf24',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            请求权限
          </button>
        </div>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>麦克风输入</span>
        <select
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          style={{
            padding: '0.3rem 0.4rem',
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            color: '#e2e8f0',
            fontSize: 12,
          }}
        >
          {inputs.map((d, i) => (
            // enumerateDevices 在权限/标签未就绪时可能给多个空 id（"default" / "communications" 等都映射到 ''），
            // 单纯用 d.id || 'default' 会触发 React 重复 key 警告。用 index 兜底保证唯一。
            <option key={`in-${d.id || 'empty'}-${i}`} value={d.id}>{d.label}</option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>
          扬声器输出{!setSinkIdSupported && <span style={{ color: '#fbbf24' }}>（当前浏览器不支持路由输出）</span>}
        </span>
        <select
          value={outputId}
          onChange={(e) => setOutputId(e.target.value)}
          disabled={!setSinkIdSupported}
          style={{
            padding: '0.3rem 0.4rem',
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            color: setSinkIdSupported ? '#e2e8f0' : '#64748b',
            fontSize: 12,
            opacity: setSinkIdSupported ? 1 : 0.6,
          }}
        >
          {outputs.map((d, i) => (
            <option key={`out-${d.id || 'empty'}-${i}`} value={d.id}>{d.label}</option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>
          TTS 音色
          <span style={{
            marginLeft: 6,
            color: speakerActive ? '#86efac' : '#fbbf24',
            fontSize: 10,
          }}>
            {backendLabel}
          </span>
        </span>
        <select
          value={speaker}
          onChange={(e) => {
            const v = e.target.value;
            setSpeaker(v);
            // 选音色 = 用户显式启用服务端 TTS（这次 onChange 自带 user gesture，
            // 后续 audio.play() 不会被 autoplay policy 拦截）。
            // 选回"使用服务端默认"也仍切到服务端，保持一致行为。
            if ((ttsBackend === 'volc' || ttsBackend === 'openai') && ttsUi !== 'server') {
              setTtsUi('server');
            }
          }}
          style={{
            padding: '0.3rem 0.4rem',
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            color: '#e2e8f0',
            fontSize: 12,
          }}
        >
          {VOLC_TTS_SPEAKERS.map((s, i) => (
            <option key={`spk-${s.id || 'empty'}-${i}`} value={s.id}>
              {s.label}
              {s.hint ? `（${s.hint}）` : ''}
            </option>
          ))}
        </select>
        <span style={{ color: '#64748b', fontSize: 11 }}>
          当前生效：{speakerActive ? speakerLabel : '浏览器内置中文 voice'}。
          {!speakerActive && (ttsBackend === 'volc' || ttsBackend === 'openai') && (
            <>
              {' '}选音色后会切换到服务端 TTS。
            </>
          )}
        </span>
      </label>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: '#cbd5e1', fontSize: 12, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={hardwareAec}
          onChange={(e) => setHardwareAec(e.target.checked)}
          style={{ marginTop: 2, accentColor: '#6366f1' }}
        />
        <span>
          <span style={{ color: '#e2e8f0' }}>硬件回声消除模式</span>
          <span style={{ display: 'block', color: '#64748b', fontSize: 11, marginTop: 2 }}>
            用蓝牙会议麦/带 AEC 的扬声器麦时勾选：关闭软件回声兜底，VAD 阈值正常、不再做滚动短窗，识别更准、延迟更低。
          </span>
        </span>
      </label>

      <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.5 }}>
        提示：选择具体输出设备后将自动改用服务端 TTS（HTML Audio），浏览器自带的 SpeechSynthesis 不能路由到指定扬声器。
      </div>
    </div>
  );
}

function ChatBubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === 'user';
  const isSys = m.role === 'system';

  if (isSys) {
    return (
      <div style={{ alignSelf: 'center', fontSize: 11, color: '#64748b', textAlign: 'center', padding: '0 1rem' }}>
        {m.text}
        <span style={{ marginLeft: 6, opacity: 0.6 }}>{fmtTime(m.timestamp)}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '88%',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div
        style={{
          padding: '0.5rem 0.7rem',
          borderRadius: 10,
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: isUser ? 'rgba(99,102,241,0.22)' : 'rgba(255,255,255,0.05)',
          border: `1px solid ${isUser ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.08)'}`,
          color: isUser ? '#dbe1ff' : '#e2e8f0',
        }}
      >
        {m.text}
      </div>
      <div
        style={{
          fontSize: 10,
          color: '#64748b',
          display: 'flex',
          gap: 8,
          padding: '0 4px',
          flexWrap: 'wrap',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
        }}
      >
        <span>{fmtTime(m.timestamp)}</span>
        {m.meta?.kind && m.meta.kind !== 'answered' && (
          <span style={{ color: '#94a3b8' }}>{m.meta.kind}</span>
        )}
        {m.meta?.sourcePages && m.meta.sourcePages.length > 0 && (
          <span>参考页：{m.meta.sourcePages.join(', ')}</span>
        )}
        {typeof m.meta?.confidence === 'number' && m.meta.confidence > 0 && (
          <span>置信 {Math.round(m.meta.confidence * 100)}%</span>
        )}
        {m.meta?.fallbackMode && <span style={{ color: '#fbbf24' }}>降级</span>}
      </div>
    </div>
  );
}
