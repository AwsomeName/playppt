import { config, type AiProvider } from '../config.js';
import { transcribeToText as transcribeOpenAi } from './asr-transcribe.js';
import { synthesizeSpeechToBuffer as synthesizeOpenAiSpeech } from './openai-tts.js';
import { transcribeWithVolc } from './volc-asr.js';
import { streamVolcSpeech } from './volc-tts.js';

export type SpeechProviderName = 'volc' | 'openai' | 'mock';
export type TtsBackendHint = 'client' | 'volc' | 'openai' | 'disabled';

export interface TranscriptionResult {
  text: string;
  provider: SpeechProviderName;
  fallbackUsed: boolean;
}

export interface TtsStreamResult {
  provider: Exclude<SpeechProviderName, 'mock'>;
}

function providerOrder(): AiProvider[] {
  if (config.aiProvider === 'mock') return ['mock'];
  if (config.aiProvider === 'openai') return ['openai', 'volc', 'mock'];
  return ['volc', 'openai', 'mock'];
}

function hasVolcSpeechConfig(): boolean {
  return Boolean(config.volc.appId && config.volc.accessToken);
}

function hasOpenAiSpeechConfig(): boolean {
  return Boolean(config.openaiApiKey);
}

export function getTtsBackendHint(): TtsBackendHint {
  if (!config.narrationTtsEnabled) return 'disabled';
  for (const p of providerOrder()) {
    if (p === 'volc' && hasVolcSpeechConfig()) return 'volc';
    if (p === 'openai' && hasOpenAiSpeechConfig()) return 'openai';
  }
  return 'client';
}

export async function transcribeAudio(input: {
  buffer: Buffer;
  filename: string;
  mime: string;
}): Promise<TranscriptionResult> {
  let firstError: unknown;
  for (const p of providerOrder()) {
    try {
      if (p === 'volc' && hasVolcSpeechConfig()) {
        return {
          text: await transcribeWithVolc(input.buffer, input.filename, input.mime),
          provider: 'volc',
          fallbackUsed: config.aiProvider !== 'volc',
        };
      }
      if (p === 'openai' && hasOpenAiSpeechConfig()) {
        return {
          text: await transcribeOpenAi(input.buffer, input.filename, input.mime, config.openaiApiKey),
          provider: 'openai',
          fallbackUsed: config.aiProvider !== 'openai',
        };
      }
      if (p === 'mock') {
        // 不返回任何"看似命令"的文本，避免误导 FSM；空 transcript 由上层处理为"未识别"。
        return { text: '', provider: 'mock', fallbackUsed: config.aiProvider !== 'mock' };
      }
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError ?? 'ASR unavailable'));
}

export async function streamSpeech(input: {
  text: string;
  writeChunk: (chunk: Buffer) => void | Promise<void>;
  /** 可选 Volc TTS speaker（OpenAI fallback 暂不支持，会被忽略）。 */
  speaker?: string;
}): Promise<TtsStreamResult> {
  let firstError: unknown;
  for (const p of providerOrder()) {
    try {
      if (p === 'volc' && hasVolcSpeechConfig()) {
        await streamVolcSpeech(input.text, input.writeChunk, input.speaker);
        return { provider: 'volc' };
      }
      if (p === 'openai' && hasOpenAiSpeechConfig()) {
        const buf = await synthesizeOpenAiSpeech(input.text, config.openaiApiKey);
        await input.writeChunk(buf);
        return { provider: 'openai' };
      }
      if (p === 'mock') break;
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError instanceof Error ? firstError : new Error('server TTS unavailable');
}
