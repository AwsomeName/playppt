import { gunzipSync, gzipSync } from 'node:zlib';

export type VolcServerFrame =
  | { kind: 'audio'; data: Buffer; done: boolean }
  | { kind: 'json'; data: unknown; done: boolean }
  | { kind: 'error'; message: string; code?: number };

const HEADER_FULL_CLIENT_REQUEST = Buffer.from([0x11, 0x10, 0x11, 0x00]);
const HEADER_AUDIO_ONLY_REQUEST = Buffer.from([0x11, 0x20, 0x00, 0x00]);
const HEADER_LAST_AUDIO_REQUEST = Buffer.from([0x11, 0x22, 0x00, 0x00]);

function sizePrefix(size: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(size, 0);
  return b;
}

export function buildJsonRequestFrame(payload: unknown): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  return Buffer.concat([HEADER_FULL_CLIENT_REQUEST, sizePrefix(body.length), body]);
}

export function buildAudioFrame(payload: Buffer, last = false): Buffer {
  const body = Buffer.from(payload);
  return Buffer.concat([
    last ? HEADER_LAST_AUDIO_REQUEST : HEADER_AUDIO_ONLY_REQUEST,
    sizePrefix(body.length),
    body,
  ]);
}

function maybeGunzip(payload: Buffer, serialization: number, compression: number): Buffer {
  if (compression === 1) return gunzipSync(payload);
  if (serialization === 1 && payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    return gunzipSync(payload);
  }
  return payload;
}

export function parseVolcServerFrame(input: Buffer): VolcServerFrame {
  if (input.length < 4) {
    return { kind: 'error', message: 'volc: empty websocket frame' };
  }
  const headerSize = (input[0]! & 0x0f) * 4;
  const messageType = (input[1]! >> 4) & 0x0f;
  const flags = input[1]! & 0x0f;
  const serialization = (input[2]! >> 4) & 0x0f;
  const compression = input[2]! & 0x0f;
  const done = flags === 0x02 || flags === 0x03;

  if (messageType === 0x0f) {
    const code = input.length >= headerSize + 8 ? input.readInt32BE(headerSize) : undefined;
    const size = input.length >= headerSize + 8 ? input.readUInt32BE(headerSize + 4) : 0;
    const payload = size > 0 ? input.subarray(headerSize + 8, headerSize + 8 + size) : Buffer.alloc(0);
    return { kind: 'error', code, message: maybeGunzip(payload, serialization, compression).toString('utf-8') };
  }

  if (messageType === 0x0b || messageType === 0x09) {
    const size = input.length >= headerSize + 4 ? input.readUInt32BE(headerSize) : 0;
    const payload = size > 0 ? input.subarray(headerSize + 4, headerSize + 4 + size) : Buffer.alloc(0);
    if (messageType === 0x0b || serialization === 0) {
      return { kind: 'audio', data: payload, done };
    }
    const text = maybeGunzip(payload, serialization, compression).toString('utf-8');
    try {
      return { kind: 'json', data: JSON.parse(text), done };
    } catch {
      return { kind: 'json', data: text, done };
    }
  }

  if (input.length >= headerSize + 4) {
    const size = input.readUInt32BE(headerSize);
    const payload = input.subarray(headerSize + 4, headerSize + 4 + size);
    const text = maybeGunzip(payload, serialization, compression).toString('utf-8');
    try {
      return { kind: 'json', data: JSON.parse(text), done };
    } catch {
      return { kind: 'json', data: text, done };
    }
  }

  return { kind: 'json', data: null, done };
}
