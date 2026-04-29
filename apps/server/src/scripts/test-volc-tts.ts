/**
 * 独立诊断脚本：直接调用火山引擎 V3 单向流式 TTS，把每一帧的解析结果打印出来，
 * 用于在不依赖前端/Express 的情况下定位 55000000 / 超时 / speaker 不匹配等问题。
 *
 * 用法：
 *   tsx apps/server/src/scripts/test-volc-tts.ts [text] [speaker=<id>] [resource=<rid>]
 *                                                 [endpoint=<wss>] [out=<path>] [timeout=<ms>]
 * 退出码：0 成功并写出 mp3；1 失败。
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import WebSocket from 'ws';

import { config } from '../config.js';
import { buildJsonRequestFrame, parseVolcServerFrame } from '../ai/volc-protocol.js';

interface CliArgs {
  text: string;
  speaker: string;
  resourceId: string;
  endpoint: string;
  outFile: string;
  timeoutMs: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let text = '';
  let speaker = config.volc.ttsSpeaker;
  let resourceId = config.volc.ttsResourceId;
  let endpoint = config.volc.ttsEndpoint;
  let outFile = resolve(config.rootDir, 'var', `volc-tts-probe-${Date.now()}.mp3`);
  let timeoutMs = 60_000;
  for (const arg of argv) {
    if (arg.startsWith('speaker=')) speaker = arg.slice('speaker='.length);
    else if (arg.startsWith('resource=')) resourceId = arg.slice('resource='.length);
    else if (arg.startsWith('endpoint=')) endpoint = arg.slice('endpoint='.length);
    else if (arg.startsWith('out=')) outFile = resolve(arg.slice('out='.length));
    else if (arg.startsWith('timeout=')) timeoutMs = Number(arg.slice('timeout='.length)) || timeoutMs;
    else if (!text) text = arg;
  }
  if (!text) text = '你好，这是火山引擎 TTS 的本地连通性测试。';
  return { text, speaker, resourceId, endpoint, outFile, timeoutMs };
}

function summarizeBuffer(buf: Buffer, headBytes = 16): string {
  if (buf.length === 0) return '<empty>';
  const head = Array.from(buf.subarray(0, Math.min(headBytes, buf.length)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return `${buf.length}B head=[${head}]`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const reqId = randomUUID();
  console.log('--- volc-tts probe ---');
  console.log('endpoint:', args.endpoint);
  console.log('resource:', args.resourceId);
  console.log('speaker :', args.speaker);
  console.log('text    :', JSON.stringify(args.text));
  console.log('reqId   :', reqId);
  console.log('appId   :', config.volc.appId ? '[set]' : '[empty]');
  console.log('access  :', config.volc.accessToken ? '[set]' : '[empty]');
  console.log('timeout :', `${args.timeoutMs}ms`);
  console.log('out     :', args.outFile);
  console.log('---');

  if (!config.volc.appId || !config.volc.accessToken) {
    console.error('volc-tts: 缺少 VOLC_APP_ID / VOLC_ACCESS_TOKEN');
    process.exit(2);
  }

  const ws = new WebSocket(args.endpoint, {
    headers: {
      'X-Api-App-Id': config.volc.appId,
      'X-Api-Access-Key': config.volc.accessToken,
      'X-Api-Resource-Id': args.resourceId,
      'X-Api-Request-Id': reqId,
    },
    handshakeTimeout: Math.min(args.timeoutMs, 15_000),
  });

  ws.on('upgrade', (res) => {
    const logId = res.headers['x-tt-logid'] ?? res.headers['x-tt-logId'] ?? '<none>';
    console.log('[ws] upgrade ok, http-status=', res.statusCode, 'x-tt-logid=', logId);
  });
  ws.on('unexpected-response', (_req, res) => {
    console.error('[ws] unexpected-response', res.statusCode, res.statusMessage);
    let body = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      console.error('[ws] resp-body', body.slice(0, 1000));
      process.exit(1);
    });
  });

  const audioChunks: Buffer[] = [];
  let firstAudioMs = 0;
  let frameIdx = 0;

  const t0 = Date.now();

  const timer = setTimeout(() => {
    console.error(`[timeout] ${args.timeoutMs}ms 内未完成，强制关闭 ws`);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }, args.timeoutMs);

  let exitedOnce = false;
  const finish = (code: number) => {
    if (exitedOnce) return;
    exitedOnce = true;
    clearTimeout(timer);
    if (audioChunks.length > 0) {
      const all = Buffer.concat(audioChunks);
      writeFileSync(args.outFile, all);
      console.log('--- summary ---');
      console.log('total_audio_bytes:', all.length);
      console.log('written:', args.outFile);
    } else {
      console.log('--- summary ---');
      console.log('no audio received.');
    }
    console.log('total_ms:', Date.now() - t0);
    process.exit(code);
  };

  ws.on('open', () => {
    console.log('[open] ws connected, ms=', Date.now() - t0);
    const payload = {
      user: { uid: 'play-ppt-probe' },
      req_params: {
        text: args.text,
        speaker: args.speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: 24_000,
        },
      },
    };
    const frame = buildJsonRequestFrame(payload);
    console.log('[send] full-client-request bytes=', frame.length);
    ws.send(frame, (err) => {
      if (err) {
        console.error('[send] error:', err);
        finish(1);
      }
    });
  });

  ws.on('message', (data) => {
    frameIdx += 1;
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.from(data as ArrayBuffer);
    let parsed;
    try {
      parsed = parseVolcServerFrame(buf);
    } catch (e) {
      console.error(`[frame#${frameIdx}] parse error`, e, summarizeBuffer(buf));
      return;
    }
    if (parsed.kind === 'error') {
      console.error(
        `[frame#${frameIdx}] ERROR code=${parsed.code} msg=${parsed.message.slice(0, 240)} (raw=${summarizeBuffer(buf)})`,
      );
      finish(1);
      return;
    }
    if (parsed.kind === 'audio') {
      if (firstAudioMs === 0) firstAudioMs = Date.now() - t0;
      audioChunks.push(parsed.data);
      console.log(
        `[frame#${frameIdx}] audio bytes=${parsed.data.length} event=${parsed.event}/${parsed.eventName} done=${parsed.done} t=${Date.now() - t0}ms`,
      );
    } else if (parsed.kind === 'json') {
      const dump = JSON.stringify(parsed.data).slice(0, 400);
      console.log(
        `[frame#${frameIdx}] json event=${parsed.event}/${parsed.eventName} done=${parsed.done} payload=${dump}`,
      );
    }
    if (parsed.done) {
      console.log(`[done] firstAudioMs=${firstAudioMs} frames=${frameIdx}`);
      ws.close();
      finish(audioChunks.length > 0 ? 0 : 1);
    }
  });

  ws.on('error', (err) => {
    console.error('[error]', err);
    finish(1);
  });

  ws.on('close', (code, reason) => {
    console.log(
      '[close] code=',
      code,
      'reason=',
      Buffer.isBuffer(reason) ? reason.toString('utf-8') : String(reason),
    );
    if (!exitedOnce) finish(audioChunks.length > 0 ? 0 : 1);
  });
}

void main();
