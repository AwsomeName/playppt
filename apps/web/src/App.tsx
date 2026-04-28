import { useCallback, useEffect, useState } from 'react';

import {
  apiGetPresentationKb,
  apiGetPresentationScripts,
  apiPutPresentationKb,
  apiPutPresentationScripts,
  apiGetSession,
  apiPatchMode,
  apiPatchSession,
  apiPostControl,
  apiStartSession,
  type SessionPayload,
} from './api.js';
import { useNarration } from './useNarration.js';
import { VoicePanel } from './VoicePanel.js';
import { SlideImageView } from './SlideImageView.js';

type Err = { message: string } | null;

export function App() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gotoN, setGotoN] = useState(1);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [hErr, setHErr] = useState<Err>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [kbJson, setKbJson] = useState('{"chunks":[]}');

  const refresh = useCallback(async (sid: string) => {
    setErr(null);
    try {
      const s = await apiGetSession(sid);
      setSession(s);
    } catch (e) {
      setSession(null);
      setErr({ message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const { ttsUi, setTtsUi, countLeft, ttsOn, hint: ttsHint } = useNarration(session, refresh);

  useEffect(() => {
    let c = false;
    fetch('/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!c) setHealth(d as Record<string, unknown>);
      })
      .catch((e: unknown) => {
        if (!c) setHErr({ message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      c = true;
    };
  }, []);

  const syncId = session?.sessionId;
  useEffect(() => {
    if (!syncId) return;
    const t = setInterval(() => {
      void refresh(syncId);
    }, 1000);
    return () => clearInterval(t);
  }, [syncId, refresh]);

  const create = async () => {
    setMsg(null);
    setErr(null);
    const r = await apiStartSession('demo');
    await refresh(r.sessionId);
  };

  const ctrl = async (action: 'start' | 'next' | 'prev' | 'goto' | 'pause' | 'resume' | 'stop', page?: number) => {
    if (!session) return;
    setMsg(null);
    setErr(null);
    const res = await apiPostControl({
      sessionId: session.sessionId,
      action,
      page: action === 'goto' ? page : undefined,
    });
    if (!res.ok) {
      setMsg(res.message ?? '控制失败');
    } else {
      setMsg(res.message ?? null);
    }
    await refresh(session.sessionId);
  };

  const onGoto = async () => {
    const p = Math.max(1, Math.trunc(gotoN));
    await ctrl('goto', p);
  };

  const setMode = async (m: 'manual' | 'auto') => {
    if (!session) return;
    setMsg(null);
    setErr(null);
    const r = await apiPatchMode(session.sessionId, m);
    if (!r.ok) {
      setMsg(r.message ?? '模式切换失败');
    } else {
      setMsg(r.message ?? null);
    }
    await refresh(session.sessionId);
  };

  const clearFallback = async () => {
    if (!session) return;
    setMsg(null);
    setErr(null);
    try {
      const r = await apiPatchSession(session.sessionId, { clearFallback: true });
      setMsg(r.message ?? null);
      await refresh(session.sessionId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const openSessionLogs = () => {
    if (!session) return;
    window.open(`/api/session/${encodeURIComponent(session.sessionId)}/logs`, '_blank', 'noopener,noreferrer');
  };

  const current =
    session && session.currentPage >= 1
      ? session.pagesData[session.currentPage - 1]
      : null;

  const currentSlideUrl =
    session?.slideImagesBaseUrl && session?.slideImages
      ? `${session.slideImagesBaseUrl}/${session.slideImages[session.currentPage - 1]?.file}`
      : null;

  useEffect(() => {
    if (current?.script !== undefined) setScriptDraft(current.script);
  }, [session?.sessionId, session?.currentPage, current?.script]);

  useEffect(() => {
    if (!session?.presentationEditorEnabled || !session.presentationId) return;
    let cancelled = false;
    void apiGetPresentationKb(session.presentationId)
      .then((k) => {
        if (!cancelled) setKbJson(JSON.stringify(k, null, 2));
      })
      .catch(() => {
        if (!cancelled) setKbJson('{"chunks":[]}');
      });
    return () => {
      cancelled = true;
    };
  }, [session?.presentationEditorEnabled, session?.presentationId]);

  const saveCurrentScript = async () => {
    if (!session?.presentationEditorEnabled) return;
    setMsg(null);
    setErr(null);
    try {
      const all = await apiGetPresentationScripts(session.presentationId);
      const scripts = all.scripts.map((s) =>
        s.pageNo === session.currentPage ? { ...s, script: scriptDraft } : s,
      );
      const r = await apiPutPresentationScripts(session.presentationId, { scripts });
      setMsg(r.hint ?? '已保存口播');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const saveKb = async () => {
    if (!session?.presentationEditorEnabled) return;
    setMsg(null);
    setErr(null);
    try {
      const body = JSON.parse(kbJson) as { chunks: unknown };
      const r = await apiPutPresentationKb(session.presentationId, {
        chunks: Array.isArray(body.chunks)
          ? (body.chunks as Array<{ id: string; title: string; body: string }>)
          : [],
      });
      setMsg(r.hint ?? '已保存知识库');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main
      style={{
        padding: '1.5rem',
        maxWidth: 960,
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #0f1419 0%, #1a2332 40%, #0f1419 100%)',
        color: '#e8edf4',
        fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ marginTop: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>play-ppt</h1>
      <p style={{ opacity: 0.85, marginTop: 0 }}>
        M2–M5：讲解 TTS、翻页与 FSM；语音意图；检索 + LLM 问答；会话 NDJSON 审计日志与{' '}
        <code>/api/session/:id/logs</code> 导出；降级时自动翻页按 manual 处理，可 PATCH 清除降级。
      </p>

      <section
        style={{
          marginTop: '1.25rem',
          padding: '0.75rem 1rem',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: 13,
        }}
      >
        <strong>健康</strong>：{hErr ? <span style={{ color: '#f59e0b' }}>失败 {hErr.message}</span> : 'OK'}
        {health != null ? (
          <pre style={{ margin: '0.5rem 0 0', color: '#94a3b8', fontSize: 12, overflow: 'auto' }}>
            {JSON.stringify(health, null, 2)}
          </pre>
        ) : null}
      </section>

      {session ? (
        <section
          style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: 13,
          }}
        >
          <strong>演示稿</strong>：{session.title}（{session.presentationId}）
          {session.deckFile ? (
            <span style={{ marginLeft: 8, color: '#94a3b8' }}>
              目标 PPT：{session.deckFile}
            </span>
          ) : null}
          {session.assetBaseUrl && session.deckFile ? (
            <a
              href={`${session.assetBaseUrl}/${encodeURIComponent(session.deckFile)}`}
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 8, color: '#93c5fd' }}
            >
              下载/查看目标 PPT
            </a>
          ) : null}
        </section>
      ) : null}

      {err && <p style={{ color: '#f87171' }}>会话错误：{err.message}</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" onClick={() => void create()}>
          创建会话 (demo)
        </button>
        {session && (
          <>
            <button type="button" onClick={() => void ctrl('start')}>
              开始
            </button>
            <button type="button" onClick={() => void ctrl('prev')}>
              上一页
            </button>
            <button type="button" onClick={() => void ctrl('next')}>
              下一页
            </button>
            <button type="button" onClick={() => void ctrl('pause')}>
              暂停
            </button>
            <button type="button" onClick={() => void ctrl('resume')}>
              继续
            </button>
            <button type="button" onClick={() => void ctrl('stop')}>
              结束
            </button>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span style={{ opacity: 0.8 }}>翻页策略</span>
              <button
                type="button"
                disabled={session?.mode === 'manual'}
                onClick={() => void setMode('manual')}
              >
                手动
              </button>
              <button
                type="button"
                disabled={session?.mode === 'auto'}
                onClick={() => void setMode('auto')}
              >
                自动
              </button>
              {session?.fallbackMode ? (
                <button type="button" onClick={() => void clearFallback()}>
                  清除降级
                </button>
              ) : null}
              <button type="button" onClick={() => openSessionLogs()}>
                会话日志 JSON
              </button>
            </span>
            {ttsOn && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ opacity: 0.8 }}>TTS</span>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="tts"
                    checked={ttsUi === 'client'}
                    onChange={() => setTtsUi('client')}
                  />
                  浏览器
                </label>
                {(ttsHint === 'openai' || ttsHint === 'volc') && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="tts"
                      checked={ttsUi === 'server'}
                      onChange={() => setTtsUi('server')}
                    />
                    {ttsHint === 'volc' ? '火山云' : 'OpenAI'}
                  </label>
                )}
              </span>
            )}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={1}
                max={session?.totalPages ?? 99}
                value={gotoN}
                onChange={(e) => setGotoN(Number(e.target.value) || 1)}
                style={{ width: 72, padding: '0.25rem' }}
                aria-label="目标页"
              />
              <button type="button" onClick={() => void onGoto()}>
                跳页
              </button>
            </span>
          </>
        )}
      </div>
      {msg && (
        <p style={{ color: '#fde047', marginTop: '0.5rem' }} title="接口提示/边界提示">
          {msg}
        </p>
      )}

      {session?.presentationEditorEnabled ? (
        <section
          style={{
            marginTop: '1rem',
            padding: '0.9rem 1rem',
            borderRadius: 10,
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.25)',
            fontSize: 13,
          }}
        >
          <strong>演示稿编辑</strong>（写磁盘；保存后请<strong>新建会话</strong>使口播与知识库生效）
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ marginBottom: 4, opacity: 0.85 }}>
              当前页（{session.currentPage}）口播 <code>scripts.json</code>
            </div>
            <textarea
              value={scriptDraft}
              onChange={(e) => setScriptDraft(e.target.value)}
              rows={5}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.5rem',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(0,0,0,0.25)',
                color: '#e8edf4',
                fontFamily: 'inherit',
              }}
            />
            <button type="button" style={{ marginTop: 6 }} onClick={() => void saveCurrentScript()}>
              保存当前页口播
            </button>
          </div>
          <div style={{ marginTop: '1rem' }}>
            <div style={{ marginBottom: 4, opacity: 0.85 }}>
              知识库 <code>kb.json</code>（JSON，供问答检索；不含口播）
            </div>
            <textarea
              value={kbJson}
              onChange={(e) => setKbJson(e.target.value)}
              rows={10}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.5rem',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(0,0,0,0.25)',
                color: '#e8edf4',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
              }}
            />
            <button type="button" style={{ marginTop: 6 }} onClick={() => void saveKb()}>
              保存知识库
            </button>
          </div>
        </section>
      ) : null}

      {session && (
        <section
          style={{
            marginTop: '1.25rem',
            padding: '0.9rem 1.1rem',
            borderRadius: 10,
            background: 'rgba(0,0,0,0.2)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.4rem 1rem',
              fontSize: 14,
            }}
          >
            <div>
              会话 <code style={{ color: '#67e8f9' }}>{session.sessionId.slice(0, 8)}…</code>
            </div>
            <div>
              页 <strong>{session.currentPage}</strong> / {session.totalPages}
            </div>
            <div style={{ gridColumn: '1 / -1' }}>状态（复合）：{session.state}</div>
            <div>顶层：{session.topState}</div>
            <div>子状态：{session.subState ?? '—'}</div>
            <div>
              模式：{session.mode}
              {session.advanceModeEffective && session.advanceModeEffective !== session.mode ? (
                <span style={{ color: '#fbbf24' }}>（FSM 生效：{session.advanceModeEffective}）</span>
              ) : null}
              （{session.mode === 'auto' ? 'TTS 后自动倒计时翻页' : 'TTS 后需点下一页'}）
            </div>
            {session.fallbackMode ? <div style={{ color: '#fbbf24' }}>降级模式：已禁用自动翻页链路上的 auto 行为</div> : null}
            {session.topState === 'interrupted' ? (
              <div style={{ color: '#fca5a5', fontSize: 13 }}>
                中断态：请先点「继续」恢复讲解；若仅想恢复自动/半自动策略，可在恢复后点「清除降级」。
              </div>
            ) : null}
            {session.narrationTtsEnabled === false && <div>TTS 已关（NARRATION_TTS_ENABLED=false）</div>}
            <div>更新：{new Date(session.updatedAt).toLocaleString()}</div>
            {session.lastError && <div style={{ color: '#f87171' }}>最近错误：{session.lastError}</div>}
          </div>
        </section>
      )}

      {session && (
        <VoicePanel
          sessionId={session.sessionId}
          onStateRefresh={() => void refresh(session.sessionId)}
        />
      )}

      {current && (
        <article
          style={{
            marginTop: '1.5rem',
            padding: '1.5rem 1.75rem',
            borderRadius: 12,
            background: '#0b1220',
            boxShadow: '0 4px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
            minHeight: 220,
            border: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <div
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: '#64748b',
              marginBottom: '0.5rem',
            }}
          >
            当前页
          </div>
          {currentSlideUrl ? (
            <SlideImageView
              url={currentSlideUrl}
              title={current.title}
              fallbackContent={current.content}
            />
          ) : (
            <div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: 26, lineHeight: 1.2 }}>{current.title}</h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 17,
                  lineHeight: 1.5,
                  color: '#cbd5e1',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {current.content}
              </p>
            </div>
          )}
          <div
            style={{
              marginTop: '1.1rem',
              paddingTop: '0.9rem',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              fontSize: 14,
              lineHeight: 1.5,
              color: '#a5b4fc',
            }}
          >
            <div style={{ fontSize: 12, color: '#6366f1', marginBottom: 4 }}>讲解词 TTS</div>
            {current.script}
            {countLeft != null && countLeft > 0 && (
              <p
                style={{
                  margin: '0.6rem 0 0',
                  color: '#34d399',
                  fontSize: 15,
                }}
              >
                自动模式：{countLeft}s 后下一页
              </p>
            )}
          </div>
        </article>
      )}

      {!session && <p style={{ marginTop: '1rem', opacity: 0.7 }}>请先「创建会话」，再点「开始」以进入 presenting 并显示第一页。</p>}
    </main>
  );
}
