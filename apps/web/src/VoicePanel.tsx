import { useCallback, useRef, useState } from 'react';

import {
  apiPostInterpret,
  apiPostVoiceTextPipeline,
  apiPostVoiceUtterance,
  type InterpretApiResult,
  type UtteranceOk,
  type VoicePipelineResult,
} from './api.js';

type Props = {
  sessionId: string;
  onStateRefresh: () => void;
};

function pickRecMime(): string {
  const c = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const m of c) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function summarizePipeline(r: VoicePipelineResult): string {
  if (r.kind === 'control') {
    return `控制：${r.result.state} 第 ${r.result.currentPage} 页`;
  }
  if (r.kind === 'answered') {
    return `已答：${r.ask.answerText.slice(0, 120)}${r.ask.answerText.length > 120 ? '…' : ''}`;
  }
  if (r.kind === 'suggest_ask') {
    return `需手动提问：${r.message}`;
  }
  return r.kind;
}

/** M4：答案用浏览器 SpeechSynthesis 播报，与无 Key 时讲解 TTS 路径一致。 */
function speakClientAnswer(text: string) {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

function summarizeInterpret(i: InterpretApiResult): string {
  if (i.kind === 'control') {
    return `命令 → ${i.result.state} 第 ${i.result.currentPage} 页`;
  }
  if (i.kind === 'ask_suggestion') {
    return `建议提问：${i.text}`;
  }
  return i.reason;
}

export function VoicePanel({ sessionId, onStateRefresh }: Props) {
  const [line, setLine] = useState('下一页');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [lastBox, setLastBox] = useState<string | null>(null);
  const recMime = useRef(pickRecMime());
  const mediaStream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const [recording, setRecording] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setErr(null);
      setBusy(true);
      try {
        await fn();
        onStateRefresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onStateRefresh],
  );

  const onInterpret = () =>
    void run(async () => {
      const r = await apiPostInterpret(sessionId, line);
      setLastTranscript(r.transcript);
      setLastBox(`[仅解析] ${summarizeInterpret(r)}`);
    });

  const onPipelineText = () =>
    void run(async () => {
      const r = await apiPostVoiceTextPipeline(sessionId, line);
      setLastTranscript(r.transcript);
      setLastBox(`[文本管线] ${summarizePipeline(r)}`);
      if (r.kind === 'answered') speakClientAnswer(r.ask.answerText);
    });

  const startRec = async () => {
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream.current = s;
      const mime = recMime.current;
      const mr = mime
        ? new MediaRecorder(s, { mimeType: mime })
        : new MediaRecorder(s);
      chunks.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.current.push(ev.data);
      };
      mr.onerror = () => {
        setErr('录音器错误');
      };
      mr.start(120);
      recorder.current = mr;
      setRecording(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '无法使用麦克风');
    }
  };

  const stopRec = () =>
    void run(async () => {
      const mr = recorder.current;
      const s = mediaStream.current;
      recorder.current = null;
      mediaStream.current = null;
      if (!mr || mr.state === 'inactive') {
        s?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (!mr) {
          setErr('未在录音');
        }
        return;
      }
      const blobReady = new Promise<Blob>((resolve) => {
        mr.onstop = () => {
          s?.getTracks().forEach((t) => t.stop());
          const t = recMime.current.includes('mp4') ? 'audio/mp4' : 'audio/webm';
          resolve(new Blob(chunks.current, { type: t }));
        };
      });
      mr.stop();
      setRecording(false);
      const blob = await blobReady;
      if (blob.size < 16) {
        setLastBox('录音过短，已忽略');
        return;
      }
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const out: UtteranceOk = await apiPostVoiceUtterance(sessionId, blob, `rec.${ext}`);
      setLastTranscript(out.transcript);
      setLastBox(`[语音] ${out.transcript} → ${summarizePipeline(out.result)}`);
      if (out.result.kind === 'answered') speakClientAnswer(out.result.ask.answerText);
    });

  return (
    <section
      style={{
        marginTop: '1.25rem',
        padding: '0.9rem 1.1rem',
        borderRadius: 10,
        background: 'rgba(99, 102, 241, 0.08)',
        border: '1px solid rgba(99, 102, 241, 0.25)',
      }}
    >
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#a5b4fc', marginBottom: 8 }}>
        M3–M4 语音与问答
      </div>
      <p style={{ margin: '0 0 0.75rem', fontSize: 13, opacity: 0.88, lineHeight: 1.45 }}>
        输入口语指令（如「下一页」）或问题；或录音后 ASR（无 Key 为占位）。命令优先；问题在讲解态下走检索
        + LLM（无 Key / 失败时降级），成功作答后会用浏览器语音简要朗读答案。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          value={line}
          onChange={(e) => setLine(e.target.value)}
          rows={2}
          style={{
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: '0.5rem 0.6rem',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.25)',
            color: '#e8edf4',
            fontSize: 15,
            resize: 'vertical' as const,
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" disabled={busy} onClick={() => void onInterpret()}>
            仅解析
          </button>
          <button type="button" disabled={busy} onClick={() => void onPipelineText()}>
            文本走管线
          </button>
          <span style={{ opacity: 0.6, fontSize: 12 }}>或</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (recording) {
                void stopRec();
              } else {
                void startRec();
              }
            }}
            style={
              recording
                ? { background: '#b91c1c', color: '#fff', fontWeight: 600 }
                : undefined
            }
          >
            {recording ? '结束并识别' : '开始录音'}
          </button>
          {busy ? <span style={{ fontSize: 13, opacity: 0.8 }}>处理中…</span> : null}
        </div>
        {err ? (
          <p style={{ margin: 0, color: '#f87171', fontSize: 14 }}>{err}</p>
        ) : null}
        {lastTranscript != null && (
          <div style={{ fontSize: 13, color: '#94a3b8' }}>
            最近转写/输入：<code style={{ color: '#5eead4' }}>{lastTranscript}</code>
          </div>
        )}
        {lastBox != null && (
          <pre
            style={{
              margin: 0,
              padding: '0.5rem 0.65rem',
              background: 'rgba(0,0,0,0.35)',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {lastBox}
          </pre>
        )}
      </div>
    </section>
  );
}
