import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 火山豆包语音 V3 二进制帧。
 *
 * 1. 客户端 → 服务端（FullClientRequest）的"通用二进制协议"沿用 1.0 风格：
 *    [4B header | 4B payload_size | gzip(JSON)]
 *    其中 header[0]=0x11(version=1, header_size=4)、header[1]=0x10(type=FullClientRequest, flags=0)、
 *    header[2]=0x11(serialization=JSON, compression=GZIP)、header[3]=0x00(reserved)。
 *    audio-only 客户端请求（ASR 上行音频）用 type=0x2 / flags=0x0 或 0x2(last)。
 *
 * 2. 服务端 → 客户端（V3 单向流式 TTS / SAUC ASR）的实际格式：
 *    [4B header | 4B event_id | 4B conn_id_size | conn_id | 4B payload_size | payload]
 *    其中 conn_id 是 UTF-8 字符串（一般 36B uuid），payload 是 audio (raw bytes) 或 json。
 *    error 帧（type=0x0F）格式：
 *    [4B header | 4B error_code | 4B msg_size | gzip 或纯文本 msg]
 *
 * 文档：https://www.volcengine.com/docs/6561/1719100 (WebSocket 单向流式-V3)
 *      https://www.volcengine.com/docs/6561/1598757 (HTTP Chunked / SSE 单向流式)
 */

export type VolcEventName =
  | 'TTSSentenceStart'
  | 'TTSSentenceEnd'
  | 'TTSResponse'
  | 'SessionFinish'
  | 'SessionFailed'
  | 'SessionCancel'
  | 'Unknown';

export interface VolcAudioFrame {
  kind: 'audio';
  data: Buffer;
  done: boolean;
  event: number;
  eventName: VolcEventName;
  connId?: string;
}

export interface VolcJsonFrame {
  kind: 'json';
  data: unknown;
  done: boolean;
  event: number;
  eventName: VolcEventName;
  connId?: string;
}

export interface VolcErrorFrame {
  kind: 'error';
  code?: number;
  message: string;
}

export type VolcServerFrame = VolcAudioFrame | VolcJsonFrame | VolcErrorFrame;

const HEADER_FULL_CLIENT_REQUEST = Buffer.from([0x11, 0x10, 0x11, 0x00]);
const HEADER_AUDIO_ONLY_REQUEST = Buffer.from([0x11, 0x20, 0x00, 0x00]);
const HEADER_LAST_AUDIO_REQUEST = Buffer.from([0x11, 0x22, 0x00, 0x00]);

export const VOLC_EVENT_TTS_SENTENCE_START = 350;
export const VOLC_EVENT_TTS_SENTENCE_END = 351;
export const VOLC_EVENT_TTS_RESPONSE = 352;
export const VOLC_EVENT_SESSION_CANCEL = 151;
export const VOLC_EVENT_SESSION_FINISH = 152;
export const VOLC_EVENT_SESSION_FAILED = 153;

function eventName(event: number): VolcEventName {
  switch (event) {
    case VOLC_EVENT_TTS_SENTENCE_START:
      return 'TTSSentenceStart';
    case VOLC_EVENT_TTS_SENTENCE_END:
      return 'TTSSentenceEnd';
    case VOLC_EVENT_TTS_RESPONSE:
      return 'TTSResponse';
    case VOLC_EVENT_SESSION_FINISH:
      return 'SessionFinish';
    case VOLC_EVENT_SESSION_FAILED:
      return 'SessionFailed';
    case VOLC_EVENT_SESSION_CANCEL:
      return 'SessionCancel';
    default:
      return 'Unknown';
  }
}

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

function maybeGunzip(payload: Buffer, compression: number): Buffer {
  if (compression === 1) {
    try {
      return gunzipSync(payload);
    } catch {
      return payload;
    }
  }
  if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    try {
      return gunzipSync(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function readLengthPrefixedString(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (buf.length < offset + 4) return null;
  const size = buf.readUInt32BE(offset);
  if (size < 0 || buf.length < offset + 4 + size) return null;
  return { value: buf.toString('utf-8', offset + 4, offset + 4 + size), next: offset + 4 + size };
}

function readLengthPrefixedBytes(buf: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (buf.length < offset + 4) return null;
  const size = buf.readUInt32BE(offset);
  if (size < 0 || buf.length < offset + 4 + size) return null;
  return { value: buf.subarray(offset + 4, offset + 4 + size), next: offset + 4 + size };
}

const KNOWN_V3_EVENTS: ReadonlySet<number> = new Set([
  VOLC_EVENT_TTS_SENTENCE_START,
  VOLC_EVENT_TTS_SENTENCE_END,
  VOLC_EVENT_TTS_RESPONSE,
  VOLC_EVENT_SESSION_CANCEL,
  VOLC_EVENT_SESSION_FINISH,
  VOLC_EVENT_SESSION_FAILED,
  // 兼容预留：建连成功 / SessionStart / TaskStarted 等火山扩展 ID。
  1, 50, 51, 52,
]);

function looksLikeConnId(value: string): boolean {
  if (value.length < 8 || value.length > 64) return false;
  // ASCII printable check：connection_id 通常是 uuid，全部为 [0-9a-fA-F-]。
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * 解析"老式"返回（[hdr | (seq?4) | 4B size | payload]，不含 event_id / conn_id），
 * 兼容 V1 协议或 SAUC ASR 大模型流式返回（每帧带 sequence number）。
 * 返回 null 表示当前帧不是该格式。
 */
function parseLegacyServerFrame(input: Buffer): VolcServerFrame | null {
  if (input.length < 4) return null;
  const headerSize = (input[0]! & 0x0f) * 4;
  const messageType = (input[1]! >> 4) & 0x0f;
  const flags = input[1]! & 0x0f;
  const compression = input[2]! & 0x0f;
  // flags 低 2 位：bit0=positive sequence；bit1=last frame。
  const hasSequence = (flags & 0x01) !== 0;
  let cursor = headerSize;
  if (hasSequence) cursor += 4;
  if (input.length < cursor + 4) return null;
  const size = input.readUInt32BE(cursor);
  if (size < 0 || input.length < cursor + 4 + size) return null;
  const payload = input.subarray(cursor + 4, cursor + 4 + size);
  const done = (flags & 0x02) !== 0;
  if (messageType === 0x0b) {
    return {
      kind: 'audio',
      data: payload,
      done,
      event: VOLC_EVENT_TTS_RESPONSE,
      eventName: 'TTSResponse',
    };
  }
  if (messageType === 0x09) {
    const text = maybeGunzip(payload, compression).toString('utf-8');
    try {
      return {
        kind: 'json',
        data: JSON.parse(text),
        done,
        event: 0,
        eventName: 'Unknown',
      };
    } catch {
      return { kind: 'json', data: text, done, event: 0, eventName: 'Unknown' };
    }
  }
  return null;
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

  // 错误帧：[hdr | 4B code | 4B size | payload]
  if (messageType === 0x0f) {
    if (input.length < headerSize + 8) {
      return { kind: 'error', message: 'volc: truncated error frame' };
    }
    const code = input.readInt32BE(headerSize);
    const size = input.readUInt32BE(headerSize + 4);
    const payload =
      size > 0 && input.length >= headerSize + 8 + size
        ? input.subarray(headerSize + 8, headerSize + 8 + size)
        : Buffer.alloc(0);
    return {
      kind: 'error',
      code,
      message: maybeGunzip(payload, compression).toString('utf-8'),
    };
  }

  // V3 服务端帧（TTS 单向流式 / TTS 双向流式）：
  //   [hdr | 4B event | 4B conn_id_size | conn_id | 4B payload_size | payload]
  // 仅当 event 是已知事件号、且 conn_id 看起来像 uuid 时才走 V3，避免误吃 ASR 老协议帧。
  let event = 0;
  let connId: string | undefined;
  let payload: Buffer | null = null;
  if (input.length >= headerSize + 4) {
    const candidateEvent = input.readInt32BE(headerSize);
    if (KNOWN_V3_EVENTS.has(candidateEvent)) {
      const conn = readLengthPrefixedString(input, headerSize + 4);
      if (conn && looksLikeConnId(conn.value)) {
        const data = readLengthPrefixedBytes(input, conn.next);
        if (data) {
          event = candidateEvent;
          connId = conn.value;
          payload = data.value;
        }
      }
    }
  }

  // 没解析到有效 V3 payload，退化到老协议（4B header + 4B size + payload）。
  if (payload === null) {
    const legacy = parseLegacyServerFrame(input);
    if (legacy) return legacy;
    return { kind: 'error', message: `volc: unsupported frame head=${input.subarray(0, 4).toString('hex')}` };
  }

  const isJson = messageType === 0x09 || serialization === 0x01;
  const done =
    event === VOLC_EVENT_SESSION_FINISH ||
    event === VOLC_EVENT_SESSION_FAILED ||
    event === VOLC_EVENT_SESSION_CANCEL ||
    (flags & 0x02) !== 0;

  if (messageType === 0x0b && !isJson) {
    return {
      kind: 'audio',
      data: payload,
      done,
      event,
      eventName: eventName(event),
      connId,
    };
  }

  const decoded = maybeGunzip(payload, compression);
  const text = decoded.toString('utf-8');
  let parsed: unknown = text;
  try {
    if (text.length > 0) parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    kind: 'json',
    data: parsed,
    done,
    event,
    eventName: eventName(event),
    connId,
  };
}
