import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { config } from '../config.js';
import { buildAudioFrame, buildJsonRequestFrame, parseVolcServerFrame } from './volc-protocol.js';

function assertVolcAsrConfigured(): void {
  if (!config.volc.appId || !config.volc.accessToken || !config.volc.asrResourceId) {
    throw new Error('volc-asr: missing VOLC_APP_ID / VOLC_ACCESS_TOKEN / VOLC_ASR_RESOURCE_ID');
  }
}

function guessAudioFormat(mime: string): string {
  const x = mime.toLowerCase();
  if (x.includes('wav')) return 'wav';
  if (x.includes('ogg') || x.includes('opus')) return 'ogg';
  if (x.includes('mp3') || x.includes('mpeg')) return 'mp3';
  if (x.includes('pcm')) return 'pcm';
  return 'webm';
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
  const connectId = randomUUID();
  const ws = new WebSocket(config.volc.asrEndpoint, {
    headers: {
      'X-Api-App-Key': config.volc.appId,
      'X-Api-Access-Key': config.volc.accessToken,
      'X-Api-Resource-Id': config.volc.asrResourceId,
      'X-Api-Connect-Id': connectId,
    },
  });
  const audioFormat = guessAudioFormat(mime);
  let finalText = '';
  let sawResponse = false;

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
      const request = {
        user: { uid: 'play-ppt' },
        audio: {
          format: audioFormat,
          sample_rate: 16_000,
          bits: 16,
          channel: 1,
        },
        request: {
          model_name: 'bigmodel',
          enable_punc: true,
          result_type: 'full',
        },
      };
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
        const frame = parseVolcServerFrame(rawToBuffer(data));
        if (frame.kind === 'error') {
          fail(new Error(`volc-asr: ${frame.code ?? 'ERR'} ${frame.message.slice(0, 240)}`));
          return;
        }
        if (frame.kind === 'json') {
          sawResponse = true;
          const text = extractText(frame.data);
          if (text) finalText = text;
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

  return finalText.trim() || '下一页';
}
