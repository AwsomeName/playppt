import { useState } from 'react';

interface PlayControlsProps {
  currentPage: number;
  totalPages: number;
  state: string;
  topState: string;
  subState: string | null;
  mode: 'manual' | 'auto';
  fallbackMode: boolean;
  advanceModeEffective?: 'manual' | 'auto';
  narrationTtsEnabled?: boolean;
  lastError?: string;
  onPrev: () => void;
  onNext: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onGoto: (page: number) => void;
  onModeSwitch: () => void;
  // 语音监听相关
  voiceWakeEnabled?: boolean;
  onVoiceWakeToggle?: () => void;
  voiceWakeSupported?: boolean;
  voiceWakeListening?: boolean;
}

export function PlayControls({
  currentPage,
  totalPages,
  topState,
  subState,
  advanceModeEffective,
  fallbackMode,
  lastError,
  onPrev,
  onNext,
  onPause,
  onResume,
  onStop,
  onGoto,
  onModeSwitch,
  voiceWakeEnabled,
  onVoiceWakeToggle,
  voiceWakeSupported,
  voiceWakeListening,
}: PlayControlsProps) {
  const [gotoInput, setGotoInput] = useState('');
  const [showGoto, setShowGoto] = useState(false);

  const canPrev = topState === 'presenting' || topState === 'paused';
  const canNext = topState === 'presenting' || topState === 'paused';
  const canPause = topState === 'presenting';
  const canResume = topState === 'paused' || topState === 'interrupted';
  const canStop = topState === 'presenting' || topState === 'paused';
  const canGoto = canPrev && subState !== 'auto_advance';
  const canSwitchMode = topState === 'presenting' || topState === 'paused';

  const handleGoto = () => {
    const p = parseInt(gotoInput, 10);
    if (p >= 1 && p <= totalPages) {
      onGoto(p);
      setGotoInput('');
      setShowGoto(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.6rem',
        padding: '0.6rem 1rem',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        zIndex: 10,
        fontSize: 14,
        color: '#e2e8f0',
      }}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        style={{
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '0.4rem 0.8rem',
          color: canPrev ? '#e2e8f0' : '#64748b',
          cursor: canPrev ? 'pointer' : 'default',
          fontSize: 16,
        }}
        aria-label="上一页"
      >
        &#9664;
      </button>

      <span style={{ minWidth: 60, textAlign: 'center', fontWeight: 600 }}>
        {currentPage}/{totalPages}
      </span>

      <button
        type="button"
        onClick={onNext}
        disabled={!canNext}
        style={{
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '0.4rem 0.8rem',
          color: canNext ? '#e2e8f0' : '#64748b',
          cursor: canNext ? 'pointer' : 'default',
          fontSize: 16,
        }}
        aria-label="下一页"
      >
        &#9654;
      </button>

      {canPause && (
        <button
          type="button"
          onClick={onPause}
          style={{
            background: 'rgba(239,68,68,0.25)',
            border: '1px solid rgba(239,68,68,0.4)',
            borderRadius: 6,
            padding: '0.35rem 0.7rem',
            color: '#fca5a5',
            cursor: 'pointer',
          }}
        >
          暂停
        </button>
      )}
      {canResume && (
        <button
          type="button"
          onClick={onResume}
          style={{
            background: 'rgba(34,197,94,0.25)',
            border: '1px solid rgba(34,197,94,0.4)',
            borderRadius: 6,
            padding: '0.35rem 0.7rem',
            color: '#86efac',
            cursor: 'pointer',
          }}
        >
          继续
        </button>
      )}

      {canStop && (
        <button
          type="button"
          onClick={onStop}
          style={{
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            padding: '0.35rem 0.7rem',
            color: '#f87171',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          结束
        </button>
      )}

      {canSwitchMode && (
        <button
          type="button"
          onClick={onModeSwitch}
          style={{
            background: 'rgba(99,102,241,0.2)',
            border: '1px solid rgba(99,102,241,0.35)',
            borderRadius: 6,
            padding: '0.35rem 0.7rem',
            color: '#a5b4fc',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {advanceModeEffective === 'auto' ? '手动' : '自动'}
        </button>
      )}

      {/* 语音监听开关 */}
      {voiceWakeSupported && onVoiceWakeToggle && (
        <button
          type="button"
          onClick={onVoiceWakeToggle}
          disabled={!canPause && !voiceWakeEnabled}
          style={{
            background: voiceWakeEnabled
              ? 'rgba(34,197,94,0.25)'
              : 'rgba(99,102,241,0.15)',
            border: `1px solid ${
              voiceWakeEnabled ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.3)'
            }`,
            borderRadius: 6,
            padding: '0.35rem 0.7rem',
            color: voiceWakeEnabled ? '#86efac' : '#a5b4fc',
            cursor: !canPause && !voiceWakeEnabled ? 'default' : 'pointer',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={voiceWakeEnabled ? '语音监听已开启，说「停一下」可暂停' : '开启语音监听'}
        >
          <span style={{ fontSize: 12 }}>{voiceWakeListening ? '●' : '○'}</span>
          {voiceWakeEnabled ? '监听中' : '语音'}
        </button>
      )}

      {canGoto && (
        <button
          type="button"
          onClick={() => setShowGoto(!showGoto)}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6,
            padding: '0.35rem 0.6rem',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          跳页
        </button>
      )}

      {fallbackMode && (
        <span style={{ color: '#fbbf24', fontSize: 12 }}>降级</span>
      )}
      {lastError && (
        <span style={{ color: '#f87171', fontSize: 12 }}>{lastError}</span>
      )}

      {showGoto && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            min={1}
            max={totalPages}
            value={gotoInput}
            onChange={(e) => setGotoInput(e.target.value)}
            placeholder="页码"
            style={{
              width: 48,
              padding: '0.25rem 0.4rem',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(0,0,0,0.3)',
              color: '#e2e8f0',
              fontSize: 13,
            }}
          />
          <button
            type="button"
            onClick={handleGoto}
            style={{
              background: 'rgba(99,102,241,0.2)',
              border: '1px solid rgba(99,102,241,0.35)',
              borderRadius: 4,
              padding: '0.25rem 0.5rem',
              color: '#a5b4fc',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Go
          </button>
        </div>
      )}
    </div>
  );
}