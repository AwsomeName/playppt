/* eslint-disable no-console */
/**
 * 从 manifest.json 生成 scripts.json。
 * 用法：npx tsx src/scripts/gen-scripts.ts --presentation=demo [--dry-run] [--merge]
 * 有 OPENAI_API_KEY 时调用 Chat Completions；否则用 title+content 拼成占位口播。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { loadPresentation, validatePresentation } from '../demo-loader.js';
import type { DemoPresentation, PresentationManifest, PresentationScripts } from '../types/presentation.js';
import { validateScriptsAgainstManifest } from '../services/presentation-files.js';

function parseArgs(argv: string[]): {
  presentationId: string;
  dryRun: boolean;
  merge: boolean;
} {
  let presentationId = 'demo';
  let dryRun = false;
  let merge = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--merge') merge = true;
    else if (a.startsWith('--presentation=')) presentationId = a.slice('--presentation='.length).trim() || 'demo';
  }
  return { presentationId, dryRun, merge };
}

function loadManifest(presentationId: string): PresentationManifest {
  const base = join(config.presentationsDir, presentationId);
  const raw = readFileSync(join(base, 'manifest.json'), 'utf-8');
  return JSON.parse(raw) as PresentationManifest;
}

function templateScripts(manifest: PresentationManifest): PresentationScripts {
  return {
    scripts: manifest.pages.map((p) => ({
      pageNo: p.pageNo,
      script: `${p.title}。${p.content}`.replace(/\s+/g, ' ').trim().slice(0, 800),
    })),
  };
}

async function llmScripts(manifest: PresentationManifest): Promise<PresentationScripts> {
  const key = config.openaiApiKey.trim();
  if (!key) {
    throw new Error('内部错误：不应在无 Key 时调用 llmScripts');
  }
  const outline = manifest.pages
    .map((p) => `## 第 ${p.pageNo} 页\n标题：${p.title}\n要点：${p.content}`)
    .join('\n\n');
  const user = `请为下列幻灯片每一页写一段中文口播稿（用于语音讲解），语气自然、口语化，每段 2～6 句，不要编造 manifest 中不存在的事实。\n\n${outline}\n\n请输出 JSON：{"scripts":[{"pageNo":1,"script":"..."},...]}，scripts 必须恰好 ${manifest.totalPages} 条且 pageNo 从 1 连续到 ${manifest.totalPages}。`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.qaLlmTimeoutMs);
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.35,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是幻灯片口播撰稿人，只输出合法 JSON，字段 scripts 为数组。',
          },
          { role: 'user', content: user },
        ],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const bodyText = await r.text();
  if (!r.ok) {
    throw new Error(`OpenAI HTTP ${r.status}: ${bodyText.slice(0, 400)}`);
  }
  const j = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = JSON.parse(content) as { scripts?: Array<{ pageNo?: number; script?: string }> };
  if (!parsed.scripts?.length) {
    throw new Error('模型返回缺少 scripts');
  }
  const scripts: PresentationScripts = {
    scripts: parsed.scripts.map((s) => ({
      pageNo: Math.trunc(Number(s.pageNo)),
      script: String(s.script ?? '').trim(),
    })),
  };
  const err = validateScriptsAgainstManifest(manifest, scripts);
  if (err) throw new Error(err);
  return scripts;
}

async function main() {
  const { presentationId, dryRun, merge } = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(presentationId);
  const base = join(config.presentationsDir, presentationId);
  const scriptsPath = join(base, 'scripts.json');

  let next: PresentationScripts;
  if (config.openaiApiKey.trim()) {
    next = await llmScripts(manifest);
  } else {
    next = templateScripts(manifest);
    // eslint-disable-next-line no-console
    console.warn('未配置 OPENAI_API_KEY，使用 title+content 模板生成口播。');
  }

  if (merge && existsSync(scriptsPath)) {
    const prev = JSON.parse(readFileSync(scriptsPath, 'utf-8')) as PresentationScripts;
    const prevMap = new Map(prev.scripts.map((s) => [s.pageNo, s.script]));
    next = {
      scripts: next.scripts.map((s) => {
        const old = prevMap.get(s.pageNo)?.trim();
        if (old) return { pageNo: s.pageNo, script: old };
        return s;
      }),
    };
    const err = validateScriptsAgainstManifest(manifest, next);
    if (err) throw new Error(err);
  }

  const merged: DemoPresentation = {
    presentationId: manifest.presentationId,
    title: manifest.title,
    totalPages: manifest.totalPages,
    deckFile: manifest.deckFile,
    ...(manifest.chapters ? { chapters: manifest.chapters } : {}),
    pages: manifest.pages.map((p) => {
      const script = next.scripts.find((s) => s.pageNo === p.pageNo)?.script ?? '';
      return { pageNo: p.pageNo, title: p.title, content: p.content, script };
    }),
  };
  validatePresentation(merged, `presentations/${presentationId} (gen-scripts)`);

  if (dryRun) {
    console.log(JSON.stringify(next, null, 2));
    return;
  }
  writeFileSync(scriptsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  console.log(`已写入 ${scriptsPath}`);
  loadPresentation(config.presentationsDir, presentationId);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
