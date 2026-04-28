import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { getTtsBackendHint, streamSpeech, transcribeAudio } from '../ai/provider.js';
import { config } from '../config.js';
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
  try {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Transfer-Encoding', 'chunked');
    const out = await streamSpeech({
      text: script,
      writeChunk: (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      },
    });
    sessionService.recordServerTtsSuccess(id);
    void appendSessionAudit(id, { type: 'tts_synthesis_success', provider: out.provider });
    res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void appendSessionAudit(id, { type: 'tts_synthesis_error', message: msg.slice(0, 500) });
    sessionService.recordServerTtsFailure(id, msg);
    res.status(502).json({
      useClientSpeech: true,
      error: msg,
    });
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
    try {
      const tr = await transcribeAudio({
        buffer: f.buffer,
        filename: f.originalname || 'utterance.webm',
        mime: f.mimetype || 'audio/webm',
      });
      transcript = tr.text;
      void appendSessionAudit(sessionId, {
        type: 'asr_transcribed',
        provider: tr.provider,
        fallbackUsed: tr.fallbackUsed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ASR 失败';
      sessionService.notifyRecoverableFailure(sessionId, { source: 'asr', messagePreview: msg });
      res.status(502).json({
        error: msg,
        hint: 'ASR provider 不可用，请检查火山云/OpenAI 配置或切到 AI_PROVIDER=mock。',
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
