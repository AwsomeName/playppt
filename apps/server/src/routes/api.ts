import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { getTtsBackendHint, streamSpeech, transcribeAudio } from '../ai/provider.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listPresentations } from '../demo-loader.js';
import {
  readPresentationKb,
  readPresentationScripts,
  writePresentationKb,
  writePresentationScripts,
} from '../services/presentation-files.js';
import { appendSessionAudit, readSessionAuditLines } from '../services/session-audit-log.js';
import {
  invalidatePresentationCache,
  sessionService,
  type ControlRequest,
} from '../services/session-service.js';
import { ensureSlidesConverted } from '../services/pptx-converter.js';
import { parsePptxPages } from '../services/pptx-parser.js';
import { splitSentences } from '../services/sentence-split.js';
import type { AdvanceMode } from '../types/session.js';
import type { PresentationKb, PresentationScripts } from '../types/presentation.js';

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

export const apiRouter = Router();

function requirePresentationEditor(_req: Request, res: Response, next: NextFunction) {
  if (!config.presentationEditorEnabled) {
    res.status(403).json({ error: '演示稿编辑未开启（设置 PPT_PRESENTATION_EDITOR=true）' });
    return;
  }
  next();
}

function safePresentationId(raw: string): string | null {
  if (!raw || !/^[a-zA-Z0-9_-]+$/.test(raw)) return null;
  return raw;
}

apiRouter.get('/presentations', (_req: Request, res: Response) => {
  res.json({
    editorEnabled: config.presentationEditorEnabled,
    presentations: listPresentations(config.presentationsDir),
  });
});

apiRouter.get('/presentations/:id/scripts', (req: Request, res: Response) => {
  const id = safePresentationId(String(req.params.id ?? ''));
  if (!id) {
    res.status(400).json({ error: 'invalid presentation id' });
    return;
  }
  try {
    res.json(readPresentationScripts(id));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.put('/presentations/:id/scripts', requirePresentationEditor, (req: Request, res: Response) => {
  const id = safePresentationId(String(req.params.id ?? ''));
  if (!id) {
    res.status(400).json({ error: 'invalid presentation id' });
    return;
  }
  const body = req.body as PresentationScripts;
  try {
    writePresentationScripts(id, body);
    invalidatePresentationCache(id);
    res.json({
      ok: true,
      hint: '已更新磁盘上的 scripts.json；已建会话仍使用旧稿，请新建会话后生效。',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.get('/presentations/:id/kb', (req: Request, res: Response) => {
  const id = safePresentationId(String(req.params.id ?? ''));
  if (!id) {
    res.status(400).json({ error: 'invalid presentation id' });
    return;
  }
  try {
    res.json(readPresentationKb(id));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.put('/presentations/:id/kb', requirePresentationEditor, (req: Request, res: Response) => {
  const id = safePresentationId(String(req.params.id ?? ''));
  if (!id) {
    res.status(400).json({ error: 'invalid presentation id' });
    return;
  }
  const body = req.body as PresentationKb;
  try {
    writePresentationKb(id, body);
    invalidatePresentationCache(id);
    res.json({
      ok: true,
      hint: '已更新磁盘上的 kb.json；已建会话仍使用旧稿，请新建会话后生效。',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.get('/presentations/:id/assets/:file', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const file = String(req.params.file ?? '');
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[^/\\]+$/.test(file)) {
    res.status(400).json({ error: 'invalid asset path' });
    return;
  }
  const p = join(config.presentationsDir, id, file);
  if (!existsSync(p)) {
    res.status(404).json({ error: 'asset not found' });
    return;
  }
  res.sendFile(p);
});

apiRouter.get('/presentations/:id/slides/:file', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const file = String(req.params.file ?? '');
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^slide-\d+\.png$/.test(file)) {
    res.status(400).json({ error: 'invalid slide file path' });
    return;
  }
  const p = join(config.presentationsDir, id, 'slides', file);
  if (!existsSync(p)) {
    res.status(404).json({ error: 'slide image not found' });
    return;
  }
  res.sendFile(p);
});

const deckUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

apiRouter.post('/presentations/upload', deckUpload.single('deck'), async (req: Request, res: Response) => {
  const f = req.file;
  if (!f?.buffer?.byteLength) {
    res.status(400).json({ error: '请提供字段名为 deck 的 pptx 文件' });
    return;
  }
  if (!f.originalname.endsWith('.pptx')) {
    res.status(400).json({ error: '仅支持 .pptx 文件' });
    return;
  }

  const id = randomUUID().slice(0, 8);
  const title = typeof (req.body as { title?: string }).title === 'string'
    ? (req.body as { title: string }).title
    : f.originalname.replace(/\.pptx$/i, '');
  const presDir = join(config.presentationsDir, id);

  try {
    mkdirSync(presDir, { recursive: true });
    const pptxPath = join(presDir, 'deck.pptx');
    writeFileSync(pptxPath, f.buffer);

    // Parse pages from pptx
    let pages;
    try {
      const parsed = parsePptxPages(pptxPath);
      pages = parsed.pages;
    } catch {
      // If parsing fails, create a generic single-page manifest
      pages = [{ pageNo: 1, title: title, content: '幻灯片内容' }];
    }

    const totalPages = pages.length;

    // Write manifest.json
    writeFileSync(join(presDir, 'manifest.json'), JSON.stringify({
      presentationId: id,
      title,
      deckFile: 'deck.pptx',
      totalPages,
      pages,
    }, null, 2));

    // Write scripts.json (template scripts based on title + content)
    writeFileSync(join(presDir, 'scripts.json'), JSON.stringify({
      scripts: pages.map((p) => ({
        pageNo: p.pageNo,
        script: `${p.title}：${p.content}`,
      })),
    }, null, 2));

    // Convert slides to images (async, don't block response)
    const slidesDir = join(presDir, 'slides');
    void ensureSlidesConverted(pptxPath, slidesDir, totalPages)
      .then((r) => {
        if (r.ok) invalidatePresentationCache(id);
      })
      .catch(() => { /* already logged */ });

    invalidatePresentationCache(id);
    res.json({ presentationId: id, title, totalPages });
  } catch (e) {
    // Cleanup on failure
    try { rmSync(presDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.delete('/presentations/:id', requirePresentationEditor, (req: Request, res: Response) => {
  const id = safePresentationId(String(req.params.id ?? ''));
  if (!id) {
    res.status(400).json({ error: 'invalid presentation id' });
    return;
  }
  const presDir = join(config.presentationsDir, id);
  if (!existsSync(presDir)) {
    res.status(404).json({ error: 'presentation not found' });
    return;
  }
  try {
    rmSync(presDir, { recursive: true, force: true });
    invalidatePresentationCache(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.post('/session/start', (req: Request, res: Response) => {
  const presentationId = (req.body as { presentationId?: string })?.presentationId;
  if (!presentationId || typeof presentationId !== 'string') {
    res.status(400).json({ error: 'presentationId 必填' });
    return;
  }
  try {
    const r = sessionService.startSession(presentationId);
    res.json(r);
  } catch (e) {
    res.status(400).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

apiRouter.post('/control', (req: Request, res: Response) => {
  const b = req.body as {
    sessionId?: string;
    action?: string;
    page?: number;
    eventId?: string;
  };
  if (!b.sessionId || typeof b.sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!sessionService.hasSession(b.sessionId)) {
    res.status(404).json({ ok: false, message: '会话不存在。' });
    return;
  }
  const act = b.action;
  if (!act || typeof act !== 'string') {
    res.status(400).json({ error: 'action 无效' });
    return;
  }
  const allActions: ControlRequest['action'][] = [
    'start',
    'next',
    'prev',
    'goto',
    'pause',
    'resume',
    'stop',
  ];
  if (!allActions.includes(act as ControlRequest['action'])) {
    res.status(400).json({ error: 'action 无效' });
    return;
  }
  const r = sessionService.control(b.sessionId, {
    action: act as ControlRequest['action'],
    page: b.page,
    eventId: b.eventId,
  });
  res.json(r);
});

apiRouter.get('/session/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  const s = sessionService.getSession(id);
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json(s);
});

apiRouter.get('/session/:id/logs', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  if (!sessionService.hasSession(id)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  try {
    const entries = await readSessionAuditLines(id);
    res.json({
      exportSchemaVersion: 1,
      sessionId: id,
      entries,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.post('/session/:id/narration', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  if (!sessionService.hasSession(id)) {
    res.status(404).json({ ok: false, message: '会话不存在。' });
    return;
  }
  const ev = (req.body as { event?: string; eventId?: string })?.event;
  const eventId = (req.body as { eventId?: string })?.eventId;
  if (ev !== 'TTS_DONE' && ev !== 'TTS_FAILED' && ev !== 'COUNTDOWN_END') {
    res.status(400).json({ error: 'event 需为 TTS_DONE | TTS_FAILED | COUNTDOWN_END' });
    return;
  }
  const map = ev === 'TTS_DONE' ? 'TTS_DONE' : ev === 'TTS_FAILED' ? 'TTS_FAILED' : 'COUNTDOWN_END';
  res.json(
    sessionService.narrationNotify(id, { event: map, eventId }),
  );
});

apiRouter.patch('/session/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  if (!sessionService.hasSession(id)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const body = req.body as { mode?: string; clearFallback?: boolean };
  const mode = body.mode;
  const clearFallback = body.clearFallback === true;
  const modeOk = mode === 'manual' || mode === 'auto';
  if (!modeOk && !clearFallback) {
    res.status(400).json({ error: '请提供 mode（manual|auto）或 clearFallback: true' });
    return;
  }
  const r = sessionService.patchSession(id, {
    ...(modeOk ? { mode: mode as AdvanceMode } : {}),
    ...(clearFallback ? { clearFallback: true } : {}),
  });
  if ('error' in r) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json(r);
});

/**
 * 返回当前页讲稿按句切分后的列表，供前端做"逐句播放 + 句间停顿"的节奏控制。
 * 切分规则在 services/sentence-split.ts，对短句会做合并。
 */
apiRouter.get('/session/:id/tts-audio/sentences', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  const s = sessionService.getSession(id);
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  if (s.currentPage < 1 || s.currentPage > s.totalPages) {
    res.status(400).json({ error: '无效 currentPage' });
    return;
  }
  const script = s.pagesData[s.currentPage - 1]?.script ?? '';
  res.json({ page: s.currentPage, sentences: splitSentences(script) });
});

apiRouter.get('/session/:id/tts-audio', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
  const s = sessionService.getSession(id);
  if (!s) {
    res.status(404).json({ useClientSpeech: true, error: '会话不存在' });
    return;
  }
  const hint = getTtsBackendHint();
  if (hint === 'client' || hint === 'disabled') {
    res.status(503).json({ useClientSpeech: true, message: '未配置可用服务端 TTS，请使用浏览器语音。' });
    return;
  }
  if (s.currentPage < 1 || s.currentPage > s.totalPages) {
    res.status(400).json({ error: '无效 currentPage' });
    return;
  }
  const script = s.pagesData[s.currentPage - 1]?.script;
  if (!script) {
    res.status(400).json({ error: '无讲解词' });
    return;
  }
  // 可选 ?sentence=N：只合成第 N 句（0-based），与 /tts-audio/sentences 配合实现逐句节奏播放。
  let textToSynth = script;
  const sentenceParam = req.query.sentence;
  if (sentenceParam != null && sentenceParam !== '') {
    const idx = Number(sentenceParam);
    const sentences = splitSentences(script);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) {
      res.status(400).json({ error: `无效的 sentence 索引（共 ${sentences.length} 句）` });
      return;
    }
    textToSynth = sentences[idx]!;
  }
  // 可选 ?speaker=xxx：覆盖默认 Volc speaker，方便前端做"音色选择"。
  // 安全：限制长度+字符集，避免请求里塞奇怪内容。
  let speakerOverride: string | undefined;
  const speakerRaw = req.query.speaker;
  if (typeof speakerRaw === 'string' && speakerRaw && /^[A-Za-z0-9_]{3,128}$/.test(speakerRaw)) {
    speakerOverride = speakerRaw;
  }
  try {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Transfer-Encoding', 'chunked');
    const out = await streamSpeech({
      text: textToSynth,
      writeChunk: (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      },
      speaker: speakerOverride,
    });
    sessionService.recordServerTtsSuccess(id);
    void appendSessionAudit(id, { type: 'tts_synthesis_success', provider: out.provider });
    res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void appendSessionAudit(id, { type: 'tts_synthesis_error', message: msg.slice(0, 500) });
    sessionService.recordServerTtsFailure(id, msg);
    // 关键：streamSpeech 中途失败时 writeChunk 可能已写出部分字节，res.headersSent 为 true。
    // 这时再调 res.status(502).json(...) 会抛 ERR_HTTP_HEADERS_SENT 把整个 Node 进程干掉
    // （Express 默认错误处理对 sync throw + 部分写后的同步抛会 propagate 到 'error' 事件链）。
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
    } else {
      res.status(502).json({
        useClientSpeech: true,
        error: msg,
      });
    }
  }
});

apiRouter.post('/interpret', (req: Request, res: Response) => {
  const b = req.body as { sessionId?: string; text?: string };
  if (!b.sessionId || typeof b.sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text 必填' });
    return;
  }
  if (!sessionService.hasSession(b.sessionId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json(sessionService.interpretText(b.sessionId, text));
});

apiRouter.post('/ask', async (req: Request, res: Response) => {
  const b = req.body as { sessionId?: string; question?: string; currentPage?: number };
  if (!b.sessionId || typeof b.sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  const q = typeof b.question === 'string' ? b.question : '';
  const p = b.currentPage;
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    res.status(400).json({ error: 'currentPage 需为有效数字' });
    return;
  }
  if (!sessionService.hasSession(b.sessionId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  try {
    const r = await sessionService.submitAsk(b.sessionId, { question: q, currentPage: Math.trunc(p) });
    if ('error' in r) {
      const code = (r as { code?: string }).code;
      const st = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' || code === 'BAD_STATE' ? 400 : 409;
      res.status(st).json({ error: r.error, code: r.code });
      return;
    }
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 已转写文本走与语音相同的管线（命令优先，否则在允许态下问答Mock）。 */
apiRouter.post('/voice/text', async (req: Request, res: Response) => {
  const b = req.body as { sessionId?: string; text?: string };
  if (!b.sessionId || typeof b.sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text 必填' });
    return;
  }
  try {
    const r = await sessionService.processVoiceText(b.sessionId, text);
    if (r.kind === 'rejected') {
      const st = r.code === 'NOT_FOUND' ? 404 : 400;
      res.status(st).json(r);
      return;
    }
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.post(
  '/voice/utterance',
  (req: Request, res: Response, next) => {
    const handler = audioUpload.single('audio');
    handler(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : '音频上传失败' });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const sessionId = typeof (req.body as { sessionId?: string }).sessionId === 'string'
      ? (req.body as { sessionId: string }).sessionId
      : undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }
    if (!sessionService.hasSession(sessionId)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    const f = req.file;
    if (!f?.buffer?.byteLength) {
      res.status(400).json({ error: '请提供字段名为 audio 的音频文件' });
      return;
    }
    let transcript: string;
    let asrProvider: string | undefined;
    let asrFallback = false;
    try {
      const tr = await transcribeAudio({
        buffer: f.buffer,
        filename: f.originalname || 'utterance.webm',
        mime: f.mimetype || 'audio/webm',
      });
      transcript = tr.text;
      asrProvider = tr.provider;
      asrFallback = !!tr.fallbackUsed;
      void appendSessionAudit(sessionId, {
        type: 'asr_transcribed',
        provider: tr.provider,
        fallbackUsed: tr.fallbackUsed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ASR 失败';
      logger.warn('voice/utterance: asr failed', {
        sessionId,
        audioBytes: f.buffer.byteLength,
        mime: f.mimetype,
        err: msg,
      });
      sessionService.notifyRecoverableFailure(sessionId, { source: 'asr', messagePreview: msg });
      res.status(502).json({
        error: msg,
        hint: 'ASR provider 不可用，请检查火山云/OpenAI 配置或切到 AI_PROVIDER=mock。',
      });
      return;
    }
    logger.info('voice/utterance: asr ok', {
      sessionId,
      audioBytes: f.buffer.byteLength,
      mime: f.mimetype,
      provider: asrProvider,
      fallback: asrFallback,
      transcriptLen: transcript.length,
      transcriptPreview: transcript.slice(0, 60),
    });
    if (!transcript.trim()) {
      // 空转写：避免被解析成意图，直接返回明确"未识别"
      res.json({
        transcript,
        result: {
          kind: 'rejected',
          transcript,
          message: '未识别到有效语音内容，请靠近麦克风重试或检查 ASR 配置。',
          code: 'EMPTY_TRANSCRIPT',
        },
      });
      return;
    }
    try {
      const r = await sessionService.processVoiceText(sessionId, transcript);
      if (r.kind === 'rejected') {
        const st = r.code === 'NOT_FOUND' ? 404 : 400;
        res.status(st).json(r);
        return;
      }
      res.json({ transcript, result: r });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);
