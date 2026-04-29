import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { config } from '../config.js';
import {
  VOLC_EVENT_SESSION_CANCEL,
  VOLC_EVENT_SESSION_FAILED,
  buildJsonRequestFrame,
  parseVolcServerFrame,
} from './volc-protocol.js';

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
 *
 * @param speaker 可选；不传时使用 config.volc.ttsSpeaker（即 .env / local.properties 默认音色）。
 *                可在请求级别覆盖，方便前端做"音色选择"而无需改全局配置。
 */
export async function streamVolcSpeech(
  text: string,
  writeChunk: WriteChunk,
  speaker?: string,
): Promise<void> {
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
          speaker: (speaker && speaker.trim()) || config.volc.ttsSpeaker,
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
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[])
            : Buffer.from(data as ArrayBuffer);
        const frame = parseVolcServerFrame(buf);
        if (frame.kind === 'error') {
          fail(new Error(`volc-tts: ${frame.code ?? 'ERR'} ${frame.message.slice(0, 240)}`));
          return;
        }
        // V3 协议里 SessionFailed/Cancel 是带 done=true 的 json 事件，要按错误处理。
        if (frame.kind === 'json' && frame.event === VOLC_EVENT_SESSION_FAILED) {
          const payloadDump = (() => {
            try {
              return JSON.stringify(frame.data).slice(0, 240);
            } catch {
              return String(frame.data).slice(0, 240);
            }
          })();
          fail(new Error(`volc-tts: SessionFailed ${payloadDump}`));
          return;
        }
        if (frame.kind === 'json' && frame.event === VOLC_EVENT_SESSION_CANCEL) {
          fail(new Error('volc-tts: SessionCancel'));
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
