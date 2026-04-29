import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '../../..');
loadEnv({ path: join(rootDir, '.env') });

import type { AdvanceMode } from './types/session.js';

export type AiProvider = 'volc' | 'openai' | 'mock';

function loadLocalProperties(): Record<string, string> {
  const p = join(rootDir, 'local.properties');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  const raw = readFileSync(p, 'utf-8');
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const localProps = loadLocalProperties();

function env(name: string, fallback = ''): string {
  // 注意：dotenv 把 ".env" 中的空字符串赋值（如 VOLC_APP_ID=）写入 process.env 后是 ''，
  // 直接用 ?? 短路无法回退到 local.properties。这里只把"非空字符串"视为有效来源。
  const fromEnv = process.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromLocal = localProps[name];
  if (typeof fromLocal === 'string' && fromLocal.trim().length > 0) return fromLocal.trim();
  return fallback.trim();
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = env(name);
  if (!raw) return defaultValue;
  return raw.toLowerCase() !== 'false';
}

function normalizeProvider(raw: string): AiProvider {
  const x = raw.toLowerCase();
  if (x === 'openai' || x === 'mock') return x;
  return 'volc';
}

const advanceEnv = (process.env.PPT_DEFAULT_ADVANCE_MODE ?? 'manual').toLowerCase();
const defaultAdvanceMode: AdvanceMode = advanceEnv === 'auto' ? 'auto' : 'manual';
const aiProvider = normalizeProvider(env('AI_PROVIDER', 'volc'));
const openaiKey = env('OPENAI_API_KEY');
const autoCountdownSec = Math.max(1, Math.min(60, Number(process.env.PPT_AUTO_ADVANCE_SEC) || 3));
const ttsFromEnv = boolEnv('NARRATION_TTS_ENABLED', true);
const asrModel = env('ASR_MODEL', 'whisper-1') || 'whisper-1';
const llmModel = env('LLM_MODEL', env('MODEL', 'gpt-4.1-mini')) || 'gpt-4.1-mini';
const qaLlmTimeoutMs = Math.max(
  3000,
  Math.min(60_000, Number(process.env.QA_LLM_TIMEOUT_MS) || 15_000),
);
/** 4.8：ASR 与 OpenAI TTS 网络请求超时（毫秒），默认 15s */
const aiSidecarTimeoutMs = Math.max(
  3000,
  Math.min(60_000, Number(process.env.PPT_AI_SIDECAR_TIMEOUT_MS) || 15_000),
);
const sessionLogsDir =
  env('PPT_SESSION_LOG_DIR') || join(rootDir, 'var', 'session-logs');

const presentationsDir = env('PPT_PRESENTATIONS_DIR') || join(rootDir, 'presentations');
const libreOfficeConvertEnabled = boolEnv('PPT_LIBREOFFICE_CONVERT', true);
const pptxConvertTimeoutMs = Math.max(
  10_000,
  Math.min(120_000, Number(process.env.PPT_CONVERT_TIMEOUT_MS) || 60_000),
);
const pptxConvertDpi = Math.max(72, Math.min(300, Number(process.env.PPT_CONVERT_DPI) || 150));
const volcAccessToken = env('VOLC_ACCESS_TOKEN');
const volcAppId = env('VOLC_APP_ID');
const volcSecretKey = env('VOLC_SECRET_KEY');
const volcTtsResourceId = env('VOLC_TTS_RESOURCE_ID', 'seed-tts-2.0');
const volcTtsSpeaker = env('VOLC_TTS_SPEAKER', 'zh_female_meilinvyou_saturn_bigtts');
const volcAsrResourceId = env('VOLC_ASR_RESOURCE_ID', 'volc.bigasr.sauc.duration');
const volcTtsEndpoint = env(
  'VOLC_TTS_ENDPOINT',
  'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
);
const volcAsrEndpoint = env('VOLC_ASR_ENDPOINT', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel');
const presentationEditorEnabled = boolEnv('PPT_PRESENTATION_EDITOR', false);

export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  rootDir,
  presentationsDir,
  aiProvider,
  defaultAdvanceMode,
  openaiApiKey: openaiKey,
  asrModel,
  llmModel,
  qaLlmTimeoutMs,
  aiSidecarTimeoutMs,
  autoAdvanceCountdownSec: autoCountdownSec,
  narrationTtsEnabled: ttsFromEnv,
  /** M5：会话结构化审计日志目录（NDJSON） */
  sessionLogsDir,
  /** 为 true 时开放 GET/PUT /api/presentations/:id/scripts 与 kb（仅本机联调建议开启） */
  presentationEditorEnabled,
  /** 是否启用 LibreOffice PPTX 转图片（设 false 则跳过，前端文本展示） */
  libreOfficeConvertEnabled,
  /** PPTX 转换超时（毫秒） */
  pptxConvertTimeoutMs,
  /** 转换 DPI（72-300） */
  pptxConvertDpi,
  volc: {
    appId: volcAppId,
    accessToken: volcAccessToken,
    secretKey: volcSecretKey,
    ttsResourceId: volcTtsResourceId,
    ttsSpeaker: volcTtsSpeaker,
    asrResourceId: volcAsrResourceId,
    ttsEndpoint: volcTtsEndpoint,
    asrEndpoint: volcAsrEndpoint,
  },
} as const;
