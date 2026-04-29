import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildAudioFrame, buildJsonRequestFrame, parseVolcServerFrame } from './volc-protocol.js';

function assertVolcAsrConfigured(): void {
  if (!config.volc.appId || !config.volc.accessToken || !config.volc.asrResourceId) {
    throw new Error('volc-asr: missing VOLC_APP_ID / VOLC_ACCESS_TOKEN / VOLC_ASR_RESOURCE_ID');
  }
}

/**
 * Volc bigasr/sauc 不支持 webm/m4a 容器，仅 wav/mp3/pcm/ogg；
 * 返回 null 表示不被支持，调用方应抛错让上层 fallback。
 */
function guessAudioFormat(mime: string): string | null {
  const x = mime.toLowerCase();
  if (x.includes('wav')) return 'wav';
  if (x.includes('ogg') || (x.includes('opus') && !x.includes('webm'))) return 'ogg';
  if (x.includes('mp3') || x.includes('mpeg')) return 'mp3';
  if (x.includes('pcm') || x.includes('raw')) return 'pcm';
  return null;
}

function extractText(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const k of ['text', 'result', 'utterance', 'transcript']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const k of ['results', 'utterances']) {
    const v = obj[k];
    if (Array.isArray(v)) {
      const parts = v.map(extractText).filter(Boolean);
      if (parts.length) return parts.join('');
    }
  }
  for (const v of Object.values(obj)) {
    const text = extractText(v);
    if (text) return text;
  }
  return '';
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function transcribeWithVolc(buffer: Buffer, _filename: string, mime: string): Promise<string> {
  assertVolcAsrConfigured();
  const audioFormat = guessAudioFormat(mime);
  if (!audioFormat) {
    throw new Error(
      `volc-asr: 不支持的音频格式 mime="${mime}"（Volc bigasr/sauc 仅支持 wav/mp3/pcm/ogg）。` +
        '请在前端使用 ogg/wav 录制，或在服务端转码后再调用。',
    );
  }
  const connectId = randomUUID();
  const ws = new WebSocket(config.volc.asrEndpoint, {
    headers: {
      'X-Api-App-Key': config.volc.appId,
      'X-Api-Access-Key': config.volc.accessToken,
      'X-Api-Resource-Id': config.volc.asrResourceId,
      'X-Api-Connect-Id': connectId,
    },
  });
  let finalText = '';
  let sawResponse = false;
  let frameCount = 0;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`volc-asr: 请求超时（>${config.aiSidecarTimeoutMs}ms）`));
    }, config.aiSidecarTimeoutMs);

    const fail = (e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    ws.once('open', () => {
      // 上层已强制前端 16kHz mono 16-bit PCM；显式声明可以避免 Volc 解析容器头部失败时无法定位采样率。
      const audioReq: Record<string, unknown> = {
        format: audioFormat,
        sample_rate: 16_000,
        bits: 16,
        channel: 1,
      };
      const request = {
        user: { uid: 'play-ppt' },
        audio: audioReq,
        request: {
          model_name: 'bigmodel',
          enable_punc: true,
          result_type: 'full',
        },
      };
      logger.debug('volc-asr: open', {
        connectId,
        audioBytes: buffer.length,
        format: audioFormat,
      });
      ws.send(buildJsonRequestFrame(request), (err) => {
        if (err) {
          fail(err);
          return;
        }
        ws.send(buildAudioFrame(buffer, true), (err2) => {
          if (err2) fail(err2);
        });
      });
    });

    ws.on('message', (data) => {
      try {
        const raw = rawToBuffer(data);
        const frame = parseVolcServerFrame(raw);
        if (frame.kind === 'error') {
          fail(new Error(`volc-asr: ${frame.code ?? 'ERR'} ${frame.message.slice(0, 240)}`));
          return;
        }
        if (frame.kind === 'json') {
          sawResponse = true;
          frameCount += 1;
          const text = extractText(frame.data);
          if (text) {
            finalText = text;
          } else if (frameCount <= 3) {
            // 头几帧若没有文字，dump 一份 truncated payload 帮助定位（结果帧通常是渐进的）
            try {
              const dump = JSON.stringify(frame.data).slice(0, 240);
              logger.debug('volc-asr: empty text frame', { connectId, frameCount, dump });
            } catch {
              // ignore
            }
          }
        }
        if (frame.done) {
          clearTimeout(timer);
          resolve();
          ws.close();
        }
      } catch (e) {
        fail(e);
      }
    });

    ws.once('error', fail);
    ws.once('close', () => {
      clearTimeout(timer);
      if (finalText || sawResponse) {
        resolve();
      } else {
        reject(new Error('volc-asr: websocket closed before transcript'));
      }
    });
  });

  const text = finalText.trim();
  logger.debug('volc-asr: done', {
    connectId,
    audioBytes: buffer.length,
    frameCount,
    transcriptLen: text.length,
  });
  if (!text) {
    throw new Error('volc-asr: 服务端返回空转写（音频可能没有可识别语音或解码失败）。');
  }
  return text;
}
