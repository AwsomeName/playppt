import { useCallback, useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  apiListPresentations,
  apiUploadPresentation,
  apiDeletePresentation,
  apiStartSession,
  apiGetPresentationScripts,
  apiPutPresentationScripts,
  apiGetPresentationKb,
  apiPutPresentationKb,
  apiUploadScriptFile,
  type PresentationListItem,
  type PresentationScriptsPayload,
} from './api.js';
import { VOLC_TTS_SPEAKERS } from './ttsSpeakers.js';

// 与 PlayPage 共享的 localStorage key（播放页 ⚙ 面板里也读写同一个 key）
const LS_TTS_SPEAKER = 'play-ppt:tts:speaker';

/** localStorage 存的音色 ID 不在当前清单（如清单从 1.0 升级到 2.0）时丢弃。 */
function readPersistedSpeaker(): string {
  if (typeof window === 'undefined') return '';
  try {
    const v = window.localStorage.getItem(LS_TTS_SPEAKER) ?? '';
    if (!v) return '';
    if (VOLC_TTS_SPEAKERS.some((s) => s.id === v)) return v;
    window.localStorage.removeItem(LS_TTS_SPEAKER);
    return '';
  } catch {
    return '';
  }
}

export function ManagePage() {
  const navigate = useNavigate();
  const [presentations, setPresentations] = useState<PresentationListItem[]>([]);
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Editing state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scripts, setScripts] = useState<PresentationScriptsPayload | null>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [scriptPage, setScriptPage] = useState(1);
  const [openingDraft, setOpeningDraft] = useState('');
  const [closingDraft, setClosingDraft] = useState('');
  const [kbJson, setKbJson] = useState('{"chunks":[]}');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scriptFileInputRef = useRef<HTMLInputElement>(null);

  // 全局播放偏好（写到 localStorage；PlayPage 启动时读同一个 key）。
  const [ttsSpeaker, setTtsSpeaker] = useState<string>(() => readPersistedSpeaker());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_TTS_SPEAKER, ttsSpeaker);
    } catch { /* ignore */ }
  }, [ttsSpeaker]);

  const loadList = useCallback(async () => {
    try {
      const r = await apiListPresentations();
      setPresentations(r.presentations);
      setEditorEnabled(r.editorEnabled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);

  // Load scripts + kb when a presentation is selected
  useEffect(() => {
    if (!selectedId) return;
    let c = false;
    void apiGetPresentationScripts(selectedId)
      .then((s) => { if (!c) setScripts(s); })
      .catch(() => { if (!c) setScripts(null); });
    void apiGetPresentationKb(selectedId)
      .then((k) => { if (!c) setKbJson(JSON.stringify(k, null, 2)); })
      .catch(() => { if (!c) setKbJson('{"chunks":[]}'); });
    return () => { c = true; };
  }, [selectedId]);

  // Sync scriptDraft from current editing page
  useEffect(() => {
    if (!scripts) return;
    const entry = scripts.scripts.find((s) => s.pageNo === scriptPage);
    setScriptDraft(entry?.script ?? '');
    setOpeningDraft(scripts.opening ?? '');
    setClosingDraft(scripts.closing ?? '');
  }, [scripts, scriptPage]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await apiUploadPresentation(file, file.name.replace(/\.pptx$/i, ''));
      setMsg(`上传成功：${r.title}（${r.totalPages} 页）`);
      await loadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`确定删除演示稿 ${id}？`)) return;
    setMsg(null);
    setErr(null);
    try {
      await apiDeletePresentation(id);
      setMsg(`已删除 ${id}`);
      if (selectedId === id) setSelectedId(null);
      await loadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePlay = async (id: string) => {
    setMsg(null);
    setErr(null);
    try {
      const r = await apiStartSession(id);
      navigate(`/play/${r.sessionId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveScript = async () => {
    if (!selectedId || !scripts) return;
    const updated = scripts.scripts.map((s) =>
      s.pageNo === scriptPage ? { ...s, script: scriptDraft } : s,
    );
    try {
      await apiPutPresentationScripts(selectedId, { opening: openingDraft, closing: closingDraft, scripts: updated });
      setScripts({ opening: openingDraft, closing: closingDraft, scripts: updated });
      setMsg('口播已保存');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveKb = async () => {
    if (!selectedId) return;
    try {
      const body = JSON.parse(kbJson) as { chunks: unknown };
      await apiPutPresentationKb(selectedId, {
        chunks: Array.isArray(body.chunks)
          ? (body.chunks as Array<{ id: string; title: string; body: string }>)
          : [],
      });
      setMsg('知识库已保存');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleUpload(f);
    e.target.value = '';
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith('.pptx')) {
      void handleUpload(f);
    } else {
      setErr('仅支持 .pptx 文件');
    }
  };

  const handleScriptFileUpload = async (file: File) => {
    if (!selectedId) {
      setErr('请先选择一个演示稿');
      return;
    }
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.md') && !ext.endsWith('.txt') && !ext.endsWith('.markdown')) {
      setErr('仅支持 .md / .txt / .markdown 文件');
      return;
    }
    setMsg(null);
    setErr(null);
    try {
      const r = await apiUploadScriptFile(selectedId, file);
      setMsg(`解说词已上传：${r.sections} 个章节分配到 ${r.totalPages} 页`);
      // 重新加载 scripts
      const updated = await apiGetPresentationScripts(selectedId);
      setScripts(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onScriptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleScriptFileUpload(f);
    e.target.value = '';
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'linear-gradient(135deg, #0f1419 0%, #1a2332 50%, #0f1419 100%)',
      color: '#e8edf4', fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
      display: 'flex', flexDirection: 'row', overflow: 'hidden',
    }}>
      {/* Left panel: list + upload */}
      <div style={{
        width: 360, minWidth: 320,
        borderRight: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column',
        overflowY: 'auto', padding: '1.5rem',
      }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>play-ppt</h1>
        <p style={{ opacity: 0.85, margin: '0.3rem 0 0', fontSize: 13 }}>管理演示稿 · 上传 PPT · 启动播放</p>

        {err && <p style={{ color: '#f87171', fontSize: 13, margin: '0.5rem 0' }}>{err}</p>}
        {msg && <p style={{ color: '#fde047', fontSize: 13, margin: '0.5rem 0' }}>{msg}</p>}

        {/* Upload area */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          style={{
            marginTop: '1rem', padding: '1rem', borderRadius: 8,
            border: '2px dashed rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.02)',
            textAlign: 'center', cursor: 'pointer',
            color: uploading ? '#64748b' : '#94a3b8', fontSize: 13,
          }}
        >
          {uploading ? '上传中...' : '拖拽 .pptx 或点击选择'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pptx"
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
        </div>

        {/* 全局播放偏好：TTS 音色等。播放页 ⚙ 面板里也可临时覆盖。 */}
        <div style={{
          marginTop: '1rem', padding: '0.75rem 0.85rem', borderRadius: 8,
          background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.18)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.9, color: '#a5b4fc' }}>
            播放偏好
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>TTS 音色</span>
            <select
              value={ttsSpeaker}
              onChange={(e) => setTtsSpeaker(e.target.value)}
              style={{
                padding: '0.35rem 0.5rem', borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.25)', color: '#e8edf4', fontSize: 13,
              }}
            >
              {VOLC_TTS_SPEAKERS.map((s, i) => (
                <option key={`spk-${s.id || 'empty'}-${i}`} value={s.id}>
                  {s.label}
                  {s.hint ? `（${s.hint}）` : ''}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
              下次启动播放时生效；播放页右上角 ⚙ 也可临时切换。
            </span>
          </label>
        </div>

        {/* Presentations list */}
        <div style={{ marginTop: '1rem', fontSize: 13, fontWeight: 600, opacity: 0.7 }}>
          演示稿列表
        </div>
        {presentations.length === 0 ? (
          <p style={{ opacity: 0.5, fontSize: 13 }}>暂无，请上传 PPT</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            {presentations.map((p) => (
              <div
                key={p.presentationId}
                onClick={() => setSelectedId(p.presentationId)}
                style={{
                  padding: '0.6rem 0.8rem', borderRadius: 6,
                  background: selectedId === p.presentationId
                    ? 'rgba(59,130,246,0.12)'
                    : 'rgba(255,255,255,0.03)',
                  border: selectedId === p.presentationId
                    ? '1px solid rgba(59,130,246,0.3)'
                    : '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>
                    {p.totalPages} 页{p.deckFile ? ' · 有 PPT' : ''}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void handlePlay(p.presentationId); }}
                      style={{
                        background: 'rgba(34,197,94,0.2)', border: '1px solid rgba(34,197,94,0.35)',
                        borderRadius: 4, padding: '0.2rem 0.6rem', color: '#86efac', cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      播放
                    </button>
                    {editorEnabled && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void handleDelete(p.presentationId); }}
                        style={{
                          background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.25)',
                          borderRadius: 4, padding: '0.2rem 0.6rem', color: '#fca5a5', cursor: 'pointer', fontSize: 12,
                        }}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right panel: editing */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '1.5rem',
        display: 'flex', flexDirection: 'column',
      }}>
        {!selectedId || !scripts ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 15,
          }}>
            选择左侧演示稿以编辑解说词
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              编辑 · {selectedId}
            </div>

            {/* Script editing */}
            <div style={{
              padding: '1rem', borderRadius: 8,
              background: 'rgba(59,130,246,0.06)',
              border: '1px solid rgba(59,130,246,0.18)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.9 }}>口播词</span>
                <button
                  type="button"
                  onClick={() => scriptFileInputRef.current?.click()}
                  style={{
                    marginLeft: 'auto',
                    background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.25)',
                    borderRadius: 4, padding: '0.2rem 0.5rem', color: '#86efac', cursor: 'pointer', fontSize: 12,
                  }}
                >
                  上传解说词
                </button>
                <input
                  ref={scriptFileInputRef}
                  type="file"
                  accept=".md,.txt,.markdown"
                  onChange={onScriptFileChange}
                  style={{ display: 'none' }}
                />
              </div>
              <span style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5, marginBottom: 6, display: 'block' }}>
                支持 .md/.txt/.markdown 文件，按 ## 标题或 --- 分隔线自动分配；含「开场」「收尾」标题的段落自动识别为开场白和收尾
              </span>

              {/* Opening textarea */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#86efac', marginBottom: 4, fontWeight: 600 }}>开场白（播放前播报）</div>
                <textarea
                  value={openingDraft}
                  onChange={(e) => setOpeningDraft(e.target.value)}
                  rows={3}
                  placeholder="无开场白时，直接从第1页讲解开始"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '0.6rem',
                    borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(0,0,0,0.2)', color: '#e8edf4',
                    fontSize: 14, lineHeight: 1.5, resize: 'vertical' as const,
                  }}
                />
              </div>

              {/* Page scripts */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, opacity: 0.7 }}>第</span>
                <select
                  value={scriptPage}
                  onChange={(e) => setScriptPage(Number(e.target.value))}
                  style={{
                    padding: '0.2rem 0.3rem', borderRadius: 4,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'rgba(0,0,0,0.2)', color: '#e8edf4', fontSize: 13,
                  }}
                >
                  {scripts.scripts.map((s) => (
                    <option key={s.pageNo} value={s.pageNo}>{s.pageNo}</option>
                  ))}
                </select>
                <span style={{ fontSize: 13, opacity: 0.7 }}>页</span>
              </div>
              <textarea
                value={scriptDraft}
                onChange={(e) => setScriptDraft(e.target.value)}
                rows={8}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '0.6rem',
                  borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(0,0,0,0.2)', color: '#e8edf4',
                  fontSize: 14, lineHeight: 1.5, resize: 'vertical' as const,
                }}
              />

              {/* Closing textarea */}
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 4, fontWeight: 600 }}>收尾（最后页之后播报）</div>
                <textarea
                  value={closingDraft}
                  onChange={(e) => setClosingDraft(e.target.value)}
                  rows={3}
                  placeholder="无收尾时，最后页播完后自动结束"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '0.6rem',
                    borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(0,0,0,0.2)', color: '#e8edf4',
                    fontSize: 14, lineHeight: 1.5, resize: 'vertical' as const,
                  }}
                />
              </div>

              <button
                type="button"
                onClick={() => void saveScript()}
                disabled={!editorEnabled}
                style={{
                  marginTop: 8,
                  background: editorEnabled ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${editorEnabled ? 'rgba(59,130,246,0.35)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 4, padding: '0.3rem 0.8rem',
                  color: editorEnabled ? '#93c5fd' : '#64748b',
                  cursor: editorEnabled ? 'pointer' : 'default', fontSize: 13,
                }}
              >
                保存口播{!editorEnabled ? '（需 PPT_PRESENTATION_EDITOR）' : ''}
              </button>
            </div>

            {/* KB editing */}
            <div style={{
              padding: '1rem', borderRadius: 8,
              background: 'rgba(99,102,241,0.06)',
              border: '1px solid rgba(99,102,241,0.18)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.9, marginBottom: 8 }}>
                知识库 kb.json
              </div>
              <textarea
                value={kbJson}
                onChange={(e) => setKbJson(e.target.value)}
                rows={10}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '0.6rem',
                  borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(0,0,0,0.2)', color: '#e8edf4',
                  fontFamily: 'ui-monospace, monospace', fontSize: 12,
                  resize: 'vertical' as const,
                }}
              />
              <button
                type="button"
                onClick={() => void saveKb()}
                disabled={!editorEnabled}
                style={{
                  marginTop: 8,
                  background: editorEnabled ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${editorEnabled ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 4, padding: '0.3rem 0.8rem',
                  color: editorEnabled ? '#a5b4fc' : '#64748b',
                  cursor: editorEnabled ? 'pointer' : 'default', fontSize: 13,
                }}
              >
                保存知识库{!editorEnabled ? '（需 PPT_PRESENTATION_EDITOR）' : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}