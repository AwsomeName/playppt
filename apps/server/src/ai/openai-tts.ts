import { config } from '../config.js';

/**
 * 服务端 TTS；Key 或网络不可用时由前端降级为 Web SpeechSynthesis / 或返回错误。
 * @see docs/ai-dev-plan.md 2.1D、4.8
 */
export async function synthesizeSpeechToBuffer(text: string, apiKey: string): Promise<Buffer> {
  const body = {
    model: 'gpt-4o-mini-tts' as const,
    voice: 'alloy' as const,
    input: text,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.aiSidecarTimeoutMs);
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && (e.name === 'AbortError' || ctrl.signal.aborted);
    if (aborted) {
      throw new Error(`openai-tts: 请求超时（>${config.aiSidecarTimeoutMs}ms）`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  clearTimeout(timer);
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`openai-tts: HTTP ${r.status} ${errText.slice(0, 220)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
