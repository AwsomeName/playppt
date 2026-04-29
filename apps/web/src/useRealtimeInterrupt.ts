import { useCallback, useEffect, useRef, useState } from 'react';

import { apiPostVoiceUtterance, type VoicePipelineResult } from './api.js';

export type CaptureStatus =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'processing'
  | 'cooldown'
  | 'error';

export interface RealtimeInterruptResult {
  transcript: string;
  result: VoicePipelineResult;
}

export interface UseRealtimeInterruptOptions {
  sessionId: string;
  enabled: boolean;
  /** 在哪些顶层状态下允许采集（默认 presenting / paused / qa） */
  activeTopStates?: ReadonlyArray<string>;
  /** 当前顶层状态。 */
  topState?: string;
  /**
   * 当前 TTS 是否在播放（即扬声器在出声）。开启时 VAD 会自动收紧阈值，
   * 减少因扬声器回授到麦克风导致的"自激打断"。
   */
  ttsPlaying?: boolean;
  /** 指定麦克风 deviceId（''/undefined 使用浏览器默认）。变更时会自动重启采集。 */
  inputDeviceId?: string;
  /**
   * 启用"硬件 AEC 模式"：当用户使用支持回声消除的会议麦/蓝牙音响时，
   * 关闭软件层的回声兜底（不再收紧 VAD 阈值、不再做滚动短窗上传），
   * 让普通"VAD 起点 → 用户说完静音 → 上传"路径生效，**延迟更低、识别更准**。
   * 默认 false，对内置喇叭/普通笔记本仍走原来的软件兜底。
   */
  hardwareAec?: boolean;
  /**
   * VAD 检测到说话起点（仅作 UI 反馈用，**不**应在此打断 TTS）。
   * 真正"是否打断 TTS"的判断在 onResult 内基于后端返回的 kind 决定。
   */
  onSpeechStart?: () => void;
  /** ASR + 后端管线返回后调用：上层据此追加聊天面板消息、决定是否打断 TTS。 */
  onResult?: (r: RealtimeInterruptResult) => void;
  /** 任意阶段错误（getUserMedia/网络/ASR/管线）。 */
  onError?: (msg: string) => void;
  /** VAD：进入"说话"阈值，单位 dBFS（负值，越接近 0 越严）。默认 -45。 */
  speechDbfs?: number;
  /** VAD：进入"静默"阈值，dBFS。默认 -55。 */
  silenceDbfs?: number;
  /** TTS 播放期间使用的更严格 speech 阈值（只在 ttsPlaying=true 时生效）。默认 -28。 */
  speechDbfsWhileTts?: number;
  /** VAD：连续超过 speechDbfs 多少毫秒视为说话起点。默认 220ms。 */
  speechHoldMs?: number;
  /** TTS 播放期间使用的更长 hold 时长（只在 ttsPlaying=true 时生效）。默认 380ms。 */
  speechHoldMsWhileTts?: number;
  /** VAD：连续低于 silenceDbfs 多少毫秒视为说话结束。默认 800ms。 */
  silenceHoldMs?: number;
  /** 单次录音最长（防止一直说不停）。默认 12s。 */
  maxRecordMs?: number;
  /** 上传后冷却（避免 TTS 答案被自身识别成新触发）。默认 1500ms。 */
  cooldownMs?: number;
  /**
   * Barge-in 滚动窗口：录音过程中每隔多少毫秒强制上传一份"快照"（不结束录音）。
   * 设为 0 关闭滚动上传，仅依赖静音/超时触发。默认 1500ms。
   *
   * 解决场景：TTS 一直在响，麦克风总能拾取到声音 → VAD 永远等不到 silence → 上传被无限推迟。
   * 滚动窗口让我们在 ~1.5s 内就把当前累积的语音发去 ASR，识别到短命令（"暂停"/"下一页"）后立即打断 TTS。
   */
  bargeInChunkMs?: number;
}

interface VadState {
  speakingStartedAt: number | null;
  silentSinceMs: number | null;
  recordingStartedAt: number | null;
  chunkStartedAt: number | null;
}

const DEFAULTS = {
  speechDbfs: -45,
  silenceDbfs: -55,
  speechDbfsWhileTts: -28,
  speechHoldMs: 220,
  speechHoldMsWhileTts: 380,
  silenceHoldMs: 800,
  maxRecordMs: 12000,
  cooldownMs: 1500,
  bargeInChunkMs: 1500,
} as const;

/** 把 Float32 单声道 PCM 编码为 mono 16-bit PCM WAV Blob。 */
function encodeWavMono16(samples: Float32Array, sampleRate: number): Blob {
  const byteLen = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLen);
  const view = new DataView(buffer);
  let pos = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(pos++, s.charCodeAt(i));
  };
  const writeU32 = (n: number) => { view.setUint32(pos, n, true); pos += 4; };
  const writeU16 = (n: number) => { view.setUint16(pos, n, true); pos += 2; };

  writeStr('RIFF');
  writeU32(36 + samples.length * 2);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(1);                 // PCM
  writeU16(1);                 // mono
  writeU32(sampleRate);
  writeU32(sampleRate * 2);    // byte rate = sr * channels * bitsPerSample/8
  writeU16(2);                 // block align
  writeU16(16);                // bits per sample
  writeStr('data');
  writeU32(samples.length * 2);

  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]!));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(pos, s, true);
    pos += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function flattenChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * 用 OfflineAudioContext 把 PCM 重采样到目标采样率（自动应用合适的低通滤波，质量优于线性插值）。
 * 失败时退回简单线性插值，保证不阻塞主链路。
 */
async function resampleTo(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  if (sourceRate === targetRate || samples.length === 0) return samples;
  try {
    const OfflineCtx: typeof OfflineAudioContext = window.OfflineAudioContext
      ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
      ?? OfflineAudioContext;
    const outLen = Math.max(1, Math.floor(samples.length * targetRate / sourceRate));
    const offline = new OfflineCtx(1, outLen, targetRate);
    const inputBuf = offline.createBuffer(1, samples.length, sourceRate);
    inputBuf.getChannelData(0).set(samples);
    const src = offline.createBufferSource();
    src.buffer = inputBuf;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch {
    // 简单线性插值降级
    const ratio = sourceRate / targetRate;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIndex = i * ratio;
      const lo = Math.floor(srcIndex);
      const hi = Math.min(samples.length - 1, lo + 1);
      const frac = srcIndex - lo;
      out[i] = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
    }
    return out;
  }
}

/**
 * 实时打断 hook：
 * - 持续打开麦克风 + Web Audio VAD（基于 RMS dBFS）；
 * - 检测到说话起点立刻 onSpeechStart（上层应取消当前 TTS）；
 * - 检测到说话结束停止录音并以 PCM WAV 上传 `/api/voice/utterance` 走管线；
 * - PCM WAV 路径不依赖浏览器 MediaRecorder 容器（兼容 Volc bigasr 仅支持 wav/ogg/mp3/pcm 的限制）；
 * - cooldown 期间不触发新一轮，避免被 TTS 答案自激活。
 */
export function useRealtimeInterrupt(opts: UseRealtimeInterruptOptions) {
  const {
    sessionId,
    enabled,
    activeTopStates = ['presenting', 'paused', 'qa'],
    topState,
    ttsPlaying = false,
    inputDeviceId = '',
    hardwareAec = false,
    onSpeechStart,
    onResult,
    onError,
    speechDbfs = DEFAULTS.speechDbfs,
    silenceDbfs = DEFAULTS.silenceDbfs,
    speechDbfsWhileTts = DEFAULTS.speechDbfsWhileTts,
    speechHoldMs = DEFAULTS.speechHoldMs,
    speechHoldMsWhileTts = DEFAULTS.speechHoldMsWhileTts,
    silenceHoldMs = DEFAULTS.silenceHoldMs,
    maxRecordMs = DEFAULTS.maxRecordMs,
    cooldownMs = DEFAULTS.cooldownMs,
    bargeInChunkMs = DEFAULTS.bargeInChunkMs,
  } = opts;

  /** 硬件 AEC 模式：把 ttsPlaying 期间的"严苛阈值"对齐到正常阈值，并关闭滚动短窗。 */
  const effectiveSpeechDbfsWhileTts = hardwareAec ? speechDbfs : speechDbfsWhileTts;
  const effectiveSpeechHoldMsWhileTts = hardwareAec ? speechHoldMs : speechHoldMsWhileTts;
  const effectiveBargeInChunkMs = hardwareAec ? 0 : bargeInChunkMs;

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [supported, setSupported] = useState(true);
  const [level, setLevel] = useState(-90);

  const cbRef = useRef({ onSpeechStart, onResult, onError });
  cbRef.current = { onSpeechStart, onResult, onError };

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const allowedRef = useRef(activeTopStates);
  allowedRef.current = activeTopStates;

  const topRef = useRef(topState);
  topRef.current = topState;

  const ttsPlayingRef = useRef(ttsPlaying);
  ttsPlayingRef.current = ttsPlaying;

  const inputDeviceIdRef = useRef(inputDeviceId);
  inputDeviceIdRef.current = inputDeviceId;

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const muteGainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sampleRateRef = useRef<number>(48000);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const recordingActiveRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const vadRef = useRef<VadState>({
    speakingStartedAt: null,
    silentSinceMs: null,
    recordingStartedAt: null,
    chunkStartedAt: null,
  });
  const cooldownUntilRef = useRef(0);
  const stoppingRef = useRef(false);
  const processingRef = useRef(false);
  const inflightRef = useRef(0);
  const lastStatusRef = useRef<CaptureStatus>('idle');

  const setStatusSafe = useCallback((s: CaptureStatus) => {
    if (lastStatusRef.current === s) return;
    lastStatusRef.current = s;
    setStatus(s);
  }, []);

  const stopAll = useCallback(() => {
    stoppingRef.current = true;
    recordingActiveRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      const p = procRef.current;
      if (p) {
        p.onaudioprocess = null;
        p.disconnect();
      }
    } catch { /* ignore */ }
    procRef.current = null;
    try {
      muteGainRef.current?.disconnect();
    } catch { /* ignore */ }
    muteGainRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch { /* ignore */ }
    sourceRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    streamRef.current = null;
    try {
      void ctxRef.current?.close();
    } catch { /* ignore */ }
    ctxRef.current = null;
    analyserRef.current = null;
    pcmChunksRef.current = [];
    vadRef.current = {
      speakingStartedAt: null,
      silentSinceMs: null,
      recordingStartedAt: null,
      chunkStartedAt: null,
    };
  }, []);

  /**
   * 内部：把音频上传走管线 → 触发 onResult。
   * mode='final' 用于 silence/maxRecordMs 触发的最终上传，会进 cooldown，期间不再触发新一轮 recording。
   * mode='snapshot' 用于录音过程中滚动上传，**不**进 cooldown、**不**清空状态，仅 fire-and-forget。
   */
  const uploadAndDispatch = useCallback(
    async (blob: Blob, mode: 'final' | 'snapshot') => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      if (mode === 'final') {
        processingRef.current = true;
        setStatusSafe('processing');
      } else {
        inflightRef.current += 1;
      }
      try {
        const out = await apiPostVoiceUtterance(sid, blob, 'barge-in.wav');
        cbRef.current.onResult?.({ transcript: out.transcript, result: out.result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        cbRef.current.onError?.(msg);
      } finally {
        if (mode === 'final') {
          processingRef.current = false;
          cooldownUntilRef.current = Date.now() + cooldownMs;
          setStatusSafe('cooldown');
        } else {
          inflightRef.current = Math.max(0, inflightRef.current - 1);
        }
      }
    },
    [cooldownMs, setStatusSafe],
  );

  /** 把当前累积的 PCM 编成 WAV（不修改状态） */
  const buildWavFromChunks = useCallback(async (chunks: Float32Array[]): Promise<Blob | null> => {
    if (!chunks.length) return null;
    const samples = flattenChunks(chunks);
    if (samples.length < sampleRateRef.current * 0.25) return null;
    const TARGET_RATE = 16_000;
    const resampled = await resampleTo(samples, sampleRateRef.current, TARGET_RATE);
    return encodeWavMono16(resampled, TARGET_RATE);
  }, []);

  const finalizeAndUpload = useCallback(async () => {
    recordingActiveRef.current = false;
    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const wav = await buildWavFromChunks(chunks);
    if (!wav) {
      cooldownUntilRef.current = Date.now() + 300;
      setStatusSafe('listening');
      return;
    }
    void uploadAndDispatch(wav, 'final');
  }, [buildWavFromChunks, setStatusSafe, uploadAndDispatch]);

  /** 录音过程中的滚动 snapshot：截当前 buffer 上传，但保持 recording 状态、清空 buffer 续录新片段。 */
  const snapshotAndUpload = useCallback(async () => {
    if (!recordingActiveRef.current) return;
    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const wav = await buildWavFromChunks(chunks);
    if (!wav) return;
    void uploadAndDispatch(wav, 'snapshot');
  }, [buildWavFromChunks, uploadAndDispatch]);

  const start = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setSupported(false);
      cbRef.current.onError?.('当前浏览器不支持麦克风采集。');
      return;
    }
    try {
      stoppingRef.current = false;
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      const did = inputDeviceIdRef.current;
      if (did) audioConstraints.deviceId = { exact: did };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;

      const Ctx: typeof AudioContext = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        ?? AudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;

      const src = ctx.createMediaStreamSource(stream);
      sourceRef.current = src;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      analyserRef.current = analyser;

      // ScriptProcessor 在大多数浏览器仍然可用；为了让它运行需要连接到 destination，
      // 故串接一个 gain=0 的 GainNode 屏蔽自激（不会播放出来）。
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      procRef.current = processor;
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      muteGainRef.current = muteGain;
      src.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(ctx.destination);

      processor.onaudioprocess = (ev) => {
        if (!recordingActiveRef.current) return;
        const input = ev.inputBuffer.getChannelData(0);
        // 拷贝（防止下一帧被 reuse）
        pcmChunksRef.current.push(new Float32Array(input));
      };

      setStatusSafe('listening');

      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (stoppingRef.current) return;
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const dbfs = rms > 0 ? 20 * Math.log10(rms) : -90;
        setLevel(Math.max(-90, Math.min(0, dbfs)));

        const now = Date.now();
        const v = vadRef.current;
        const inCooldown = now < cooldownUntilRef.current;
        const isProcessing = processingRef.current;
        const allowedTops = allowedRef.current;
        const allowedNow = !!enabledRef.current && (!topRef.current || allowedTops.includes(topRef.current));

        if (recordingActiveRef.current) {
          // 录音中：判断结束 / 滚动 snapshot
          const recStarted = v.recordingStartedAt ?? now;
          const chunkStarted = v.chunkStartedAt ?? recStarted;
          let finalized = false;
          if (dbfs <= silenceDbfs) {
            v.silentSinceMs = v.silentSinceMs ?? now;
            if (now - v.silentSinceMs >= silenceHoldMs || now - recStarted >= maxRecordMs) {
              v.silentSinceMs = null;
              v.recordingStartedAt = null;
              v.chunkStartedAt = null;
              v.speakingStartedAt = null;
              void finalizeAndUpload();
              finalized = true;
            }
          } else {
            v.silentSinceMs = null;
            if (now - recStarted >= maxRecordMs) {
              v.recordingStartedAt = null;
              v.chunkStartedAt = null;
              v.speakingStartedAt = null;
              void finalizeAndUpload();
              finalized = true;
            }
          }
          // TTS 期间扬声器一直响 → silence 几乎永不触发；
          // 只在 TTS 在播时启用滚动窗口，让短命令（"暂停"/"下一页"）能在 ~1.5s 内被识别打断。
          // TTS 不在播时仍走 silence-end 完整路径，避免把长问句切碎。
          if (
            !finalized
            && effectiveBargeInChunkMs > 0
            && ttsPlayingRef.current
            && now - chunkStarted >= effectiveBargeInChunkMs
          ) {
            v.chunkStartedAt = now;
            void snapshotAndUpload();
          }
        } else if (allowedNow && !inCooldown && !isProcessing) {
          // TTS 在播时收紧阈值，避免扬声器回授触发录音（"自激"）；
          // hardwareAec=true 时 effectiveSpeechDbfsWhileTts === speechDbfs，相当于不收紧。
          const effSpeechDbfs = ttsPlayingRef.current ? effectiveSpeechDbfsWhileTts : speechDbfs;
          const effSpeechHoldMs = ttsPlayingRef.current ? effectiveSpeechHoldMsWhileTts : speechHoldMs;
          if (dbfs >= effSpeechDbfs) {
            v.speakingStartedAt = v.speakingStartedAt ?? now;
            if (now - v.speakingStartedAt >= effSpeechHoldMs) {
              // 触发 barge-in
              v.silentSinceMs = null;
              v.recordingStartedAt = now;
              v.chunkStartedAt = now;
              cbRef.current.onSpeechStart?.();
              pcmChunksRef.current = [];
              recordingActiveRef.current = true;
              setStatusSafe('recording');
            }
          } else {
            v.speakingStartedAt = null;
          }
        } else if (isProcessing) {
          // 状态由 uploadAndDispatch 维护
        } else if (inCooldown) {
          setStatusSafe('cooldown');
        } else if (allowedNow) {
          setStatusSafe('listening');
        }

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cbRef.current.onError?.(`无法启动麦克风：${msg}`);
      setStatusSafe('error');
      stopAll();
    }
  }, [
    effectiveBargeInChunkMs,
    effectiveSpeechDbfsWhileTts,
    effectiveSpeechHoldMsWhileTts,
    finalizeAndUpload,
    maxRecordMs,
    setStatusSafe,
    silenceDbfs,
    silenceHoldMs,
    snapshotAndUpload,
    speechDbfs,
    speechHoldMs,
    stopAll,
  ]);

  useEffect(() => {
    if (!enabled) {
      stopAll();
      setStatusSafe('idle');
      return;
    }
    void start();
    return () => {
      stopAll();
    };
    // inputDeviceId 变化时关闭旧 stream 并以新设备重启
  }, [enabled, inputDeviceId, start, stopAll, setStatusSafe]);

  return { status, supported, level };
}
