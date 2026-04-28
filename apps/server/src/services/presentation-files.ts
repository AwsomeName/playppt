import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { loadPresentation, validatePresentation } from '../demo-loader.js';
import type {
  PresentationKb,
  PresentationManifest,
  PresentationScripts,
} from '../types/presentation.js';

export function readPresentationManifest(presentationId: string): PresentationManifest {
  const base = join(config.presentationsDir, presentationId);
  return JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf-8')) as PresentationManifest;
}

export function readPresentationScripts(presentationId: string): PresentationScripts {
  const base = join(config.presentationsDir, presentationId);
  return JSON.parse(readFileSync(join(base, 'scripts.json'), 'utf-8')) as PresentationScripts;
}

export function readPresentationKb(presentationId: string): PresentationKb {
  const base = join(config.presentationsDir, presentationId);
  const p = join(base, 'kb.json');
  if (!existsSync(p)) {
    return { chunks: [] };
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as PresentationKb;
}

export function validateScriptsAgainstManifest(
  manifest: PresentationManifest,
  scripts: PresentationScripts,
): string | null {
  if (!Array.isArray(scripts.scripts)) return 'scripts.scripts 需为数组';
  if (scripts.scripts.length !== manifest.totalPages) {
    return `scripts 条数 (${scripts.scripts.length}) 与 manifest.totalPages (${manifest.totalPages}) 不一致`;
  }
  const seen = new Set<number>();
  for (const s of scripts.scripts) {
    if (typeof s.pageNo !== 'number' || !Number.isInteger(s.pageNo) || s.pageNo < 1) {
      return `无效 pageNo: ${String(s.pageNo)}`;
    }
    if (seen.has(s.pageNo)) return `重复 pageNo: ${s.pageNo}`;
    seen.add(s.pageNo);
    if (typeof s.script !== 'string' || !s.script.trim()) {
      return `第 ${s.pageNo} 页 script 不能为空`;
    }
  }
  for (let i = 1; i <= manifest.totalPages; i++) {
    if (!seen.has(i)) return `缺少第 ${i} 页的 script`;
  }
  return null;
}

export function validateKbPayload(kb: PresentationKb): string | null {
  if (!kb || !Array.isArray(kb.chunks)) return 'kb.chunks 需为数组';
  const ids = new Set<string>();
  for (const c of kb.chunks) {
    if (typeof c.id !== 'string' || !c.id.trim()) return '每条 chunk 需有非空 id';
    if (ids.has(c.id.trim())) return `重复 id: ${c.id}`;
    ids.add(c.id.trim());
    if (typeof c.title !== 'string' || !c.title.trim()) return `chunk ${c.id} 需有非空 title`;
    if (typeof c.body !== 'string') return `chunk ${c.id} 的 body 需为字符串`;
  }
  return null;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, filePath);
}

export function writePresentationScripts(presentationId: string, scripts: PresentationScripts): void {
  const manifest = readPresentationManifest(presentationId);
  const err = validateScriptsAgainstManifest(manifest, scripts);
  if (err) throw new Error(err);
  const base = join(config.presentationsDir, presentationId);
  atomicWriteJson(join(base, 'scripts.json'), scripts);
  const merged = loadPresentation(config.presentationsDir, presentationId);
  validatePresentation(merged, `presentations/${presentationId} after scripts write`);
}

export function writePresentationKb(presentationId: string, kb: PresentationKb): void {
  const err = validateKbPayload(kb);
  if (err) throw new Error(err);
  const base = join(config.presentationsDir, presentationId);
  atomicWriteJson(join(base, 'kb.json'), kb);
  const merged = loadPresentation(config.presentationsDir, presentationId);
  validatePresentation(merged, `presentations/${presentationId} after kb write`);
}
