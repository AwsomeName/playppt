import { useCallback, useEffect, useRef, useState } from 'react';

import { apiPostControl, apiPostVoiceTextPipeline } from './api.js';

export type WakeWordType = 'pause' | 'resume' | 'next' | 'prev' | 'ask';

export interface WakeWordConfig {
  type: WakeWordType;
  patterns: string[];
  action: 'control' | 'pipeline';
}

/** 默认唤醒词配置 */
export const DEFAULT_WAKE_WORDS: WakeWordConfig[] = [
  {
    type: 'pause',
    patterns: ['停一下', '暂停', '打断', '等等', '等一下', '别讲了', '停'],
    action: 'control',
  },
  {
    type: 'resume',
    patterns: ['继续', '恢复', '讲下去', '开始讲', '播放'],
    action: 'control',
  },
  {
    type: 'next',
    patterns: ['下一页', '往后', '下一个', '下一张', '下一章'],
    action: 'control',
  },
  {
    type: 'prev',
    patterns: ['上一页', '往前', '上一个', '前一张', '上一章', '返回'],
    action: 'control',
  },
  {
    type: 'ask',
    patterns: ['提问', '请问', '我想问', '问题'],
    action: 'pipeline',
  },
];

export interface VoiceWakeState {
  isListening: boolean;
  isSupported: boolean;
  lastTranscript: string | null;
  lastWakeWord: WakeWordType | null;
  error: string | null;
}

export interface UseVoiceWakeOptions {
  sessionId: string;
  enabled: boolean;
  onStateRefresh: () => void;
  wakeWords?: WakeWordConfig[];
  /** 识别到唤醒词后的冷却时间（毫秒），防止重复触发 */
  cooldownMs?: number;
}

/**
 * 语音唤醒 hook：持续监听语音，识别唤醒词并执行对应操作
 * 使用 Web Speech API (SpeechRecognition)
 */
export function useVoiceWake(options: UseVoiceWakeOptions): VoiceWakeState {
  const { sessionId, enabled, onStateRefresh, wakeWords = DEFAULT_WAKE_WORDS, cooldownMs = 2000 } = options;

  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [lastWakeWord, setLastWakeWord] = useState<WakeWordType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const cooldownRef = useRef(false);
  const enabledRef = useRef(enabled);
  const sessionIdRef = useRef(sessionId);

  // 保持 ref 最新
  useEffect(() => {
    enabledRef.current = enabled;
    sessionIdRef.current = sessionId;
  }, [enabled, sessionId]);

  // 检查浏览器支持
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    setIsSupported(!!SpeechRecognitionAPI);
  }, []);

  // 匹配唤醒词
  const matchWakeWord = useCallback((transcript: string): WakeWordConfig | null => {
    const t = transcript.toLowerCase().replace(/\s+/g, '');
    for (const config of wakeWords) {
      for (const pattern of config.patterns) {
        if (t.includes(pattern.toLowerCase().replace(/\s+/g, ''))) {
          return config;
        }
      }
    }
    return null;
  }, [wakeWords]);

  // 执行唤醒词对应的操作
  const executeWakeWord = useCallback(
    async (config: WakeWordConfig, transcript: string) => {
      if (cooldownRef.current) return;

      try {
        cooldownRef.current = true;
        setLastWakeWord(config.type);

        switch (config.type) {
          case 'pause':
            await apiPostControl({ sessionId: sessionIdRef.current, action: 'pause' });
            break;
          case 'resume':
            await apiPostControl({ sessionId: sessionIdRef.current, action: 'resume' });
            break;
          case 'next':
            await apiPostControl({ sessionId: sessionIdRef.current, action: 'next' });
            break;
          case 'prev':
            await apiPostControl({ sessionId: sessionIdRef.current, action: 'prev' });
            break;
          case 'ask':
            // 对于提问类型，尝试通过 pipeline 处理（提取问题部分）
            await apiPostVoiceTextPipeline(sessionIdRef.current, transcript);
            break;
        }

        onStateRefresh();

        // 冷却期后重置
        setTimeout(() => {
          cooldownRef.current = false;
          setLastWakeWord(null);
        }, cooldownMs);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        cooldownRef.current = false;
      }
    },
    [cooldownMs, onStateRefresh]
  );

  // 初始化语音识别
  useEffect(() => {
    if (!isSupported || typeof window === 'undefined') return;

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onend = () => {
      setIsListening(false);
      // 如果仍然启用，自动重启监听
      if (enabledRef.current && !cooldownRef.current) {
        setTimeout(() => {
          try {
            recognition.start();
          } catch {
            // 可能已经在启动中或已停止
          }
        }, 100);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') {
        // 无语音是正常现象，不报错
        return;
      }
      if (event.error === 'aborted') {
        // 用户主动停止，不报错
        return;
      }
      setError(`识别错误: ${event.error}`);
      setIsListening(false);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i]![0].transcript;
        if (event.results[i]!.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const transcript = finalTranscript || interimTranscript;
      if (transcript) {
        setLastTranscript(transcript);

        // 检查是否匹配唤醒词
        const wakeWord = matchWakeWord(transcript);
        if (wakeWord && (finalTranscript || transcript.length > 3)) {
          void executeWakeWord(wakeWord, transcript);
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.stop();
      } catch {
        // 忽略停止错误
      }
      recognitionRef.current = null;
    };
  }, [isSupported, matchWakeWord, executeWakeWord]);

  // 控制监听状态
  useEffect(() => {
    if (!recognitionRef.current) return;

    if (enabled && !isListening) {
      try {
        recognitionRef.current.start();
      } catch {
        // 可能已经在监听中
      }
    } else if (!enabled && isListening) {
      try {
        recognitionRef.current.stop();
      } catch {
        // 忽略停止错误
      }
    }
  }, [enabled, isListening]);

  return {
    isListening,
    isSupported,
    lastTranscript,
    lastWakeWord,
    error,
  };
}
