import { config } from '../config.js';

/**
 * OpenAI audio/transcriptions。无 Key 时 2.1D mock 固定文案。
 * @see docs/ai-dev-plan 2.1D
 */
export async function transcribeToText(
  buffer: Buffer,
  filename: string,
  mime: string,
  apiKey: string,
): Promise<string> {
  if (!apiKey) {
    return '下一页';
  }
  const u8 = new Uint8Array(buffer);
  const form = new FormData();
  const f = new File([u8], filename || 'audio.webm', { type: mime || 'audio/webm' });
  form.set('file', f);
  form.set('model', config.asrModel);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.aiSidecarTimeoutMs);
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && (e.name === 'AbortError' || ctrl.signal.aborted);
    if (aborted) {
      throw new Error(`asr: 请求超时（>${config.aiSidecarTimeoutMs}ms）`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  clearTimeout(timer);
  if (!r.ok) {
    const x = await r.text();
    throw new Error(`asr: ${r.status} ${x.slice(0, 300)}`);
  }
  const j = (await r.json()) as { text?: string };
  return (j.text ?? '').trim() || '下一页';
}
