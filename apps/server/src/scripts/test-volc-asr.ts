/**
 * 独立诊断脚本：用本地音频文件直接调用 transcribeWithVolc，验证云端 ASR 链路可用性。
 * 用法：
 *   tsx apps/server/src/scripts/test-volc-asr.ts <wav-file>
 * 退出码：0 成功并打印转写；1 失败。
 */
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { transcribeWithVolc } from '../ai/volc-asr.js';
import { config } from '../config.js';

function guessMime(p: string): string {
  const e = extname(p).toLowerCase();
  if (e === '.wav') return 'audio/wav';
  if (e === '.mp3') return 'audio/mpeg';
  if (e === '.ogg') return 'audio/ogg';
  if (e === '.pcm') return 'audio/pcm';
  return 'application/octet-stream';
}

function readWavInfo(buf: Buffer): { sampleRate: number; bitsPerSample: number; channels: number } | null {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  return { sampleRate, bitsPerSample, channels };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: tsx apps/server/src/scripts/test-volc-asr.ts <wav-file>');
    process.exit(2);
  }
  const abs = resolve(file);
  const buf = readFileSync(abs);
  const mime = guessMime(abs);
  const wav = readWavInfo(buf);
  console.log('--- volc asr probe ---');
  console.log('file:', abs, 'bytes:', buf.length, 'mime:', mime);
  if (wav) {
    console.log('wav header:', wav);
  }
  console.log('config.volc.appId:', config.volc.appId ? '[set]' : '[empty]');
  console.log('config.volc.accessToken:', config.volc.accessToken ? '[set]' : '[empty]');
  console.log('config.volc.asrResourceId:', config.volc.asrResourceId);
  console.log('config.volc.asrEndpoint:', config.volc.asrEndpoint);
  const t0 = Date.now();
  try {
    const text = await transcribeWithVolc(buf, abs, mime);
    console.log('--- transcript ok ---');
    console.log('duration_ms:', Date.now() - t0, 'len:', text.length);
    console.log('text:', JSON.stringify(text));
    process.exit(0);
  } catch (e) {
    console.error('--- transcript failed ---');
    console.error('duration_ms:', Date.now() - t0);
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  }
}

void main();
