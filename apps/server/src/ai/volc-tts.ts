import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { config } from '../config.js';
import { buildJsonRequestFrame, parseVolcServerFrame } from './volc-protocol.js';

type WriteChunk = (chunk: Buffer) => void | Promise<void>;

function assertVolcTtsConfigured(): void {
  if (!config.volc.appId || !config.volc.accessToken || !config.volc.ttsResourceId) {
    throw new Error('volc-tts: missing VOLC_APP_ID / VOLC_ACCESS_TOKEN / VOLC_TTS_RESOURCE_ID');
  }
}

function openTtsSocket(reqId: string): WebSocket {
  assertVolcTtsConfigured();
  return new WebSocket(config.volc.ttsEndpoint, {
    headers: {
      'X-Api-App-Id': config.volc.appId,
      'X-Api-Access-Key': config.volc.accessToken,
      'X-Api-Resource-Id': config.volc.ttsResourceId,
      'X-Api-Request-Id': reqId,
    },
  });
}

/**
 * 火山云 TTS 单向流式：后端接收 WebSocket 音频分片并转写给 HTTP response。
 * 协议失败时由上层回退 OpenAI 或浏览器 SpeechSynthesis。
 */
export async function streamVolcSpeech(text: string, writeChunk: WriteChunk): Promise<void> {
  const reqId = randomUUID();
  const ws = openTtsSocket(reqId);
  let audioSeen = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`volc-tts: 请求超时（>${config.aiSidecarTimeoutMs}ms）`));
    }, config.aiSidecarTimeoutMs);

    const fail = (e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    ws.once('open', () => {
      const payload = {
        user: { uid: 'play-ppt' },
        req_params: {
          text,
          speaker: config.volc.ttsSpeaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24_000,
          },
        },
      };
      ws.send(buildJsonRequestFrame(payload), (err) => {
        if (err) fail(err);
      });
    });

    ws.on('message', (data) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const frame = parseVolcServerFrame(buf);
        if (frame.kind === 'error') {
          fail(new Error(`volc-tts: ${frame.code ?? 'ERR'} ${frame.message.slice(0, 240)}`));
          return;
        }
        if (frame.kind === 'audio' && frame.data.length > 0) {
          audioSeen = true;
          void Promise.resolve(writeChunk(frame.data)).catch(fail);
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
      if (audioSeen) {
        resolve();
      } else {
        reject(new Error('volc-tts: websocket closed before audio'));
      }
    });
  });
}
