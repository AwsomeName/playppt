import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  DemoPresentation,
  PresentationKb,
  PresentationManifest,
  PresentationScripts,
  SlideManifest,
} from './types/presentation.js';

export function validatePresentation(data: DemoPresentation, label: string): DemoPresentation {
  if (!data.pages?.length) {
    throw new Error(`${label}: pages is empty`);
  }
  if (data.totalPages !== data.pages.length) {
    throw new Error(
      `${label}: totalPages (${data.totalPages}) !== pages.length (${data.pages.length})`,
    );
  }
  for (let i = 0; i < data.pages.length; i++) {
    const p = data.pages[i];
    if (p.pageNo !== i + 1) {
      throw new Error(`${label}: expected pageNo ${i + 1}, got ${p.pageNo}`);
    }
    if (!p.script.trim()) {
      throw new Error(`${label}: page ${p.pageNo} script is empty`);
    }
  }
  return data;
}

export function loadDemoPresentation(fixturesDir: string): DemoPresentation {
  const raw = readFileSync(join(fixturesDir, 'demo.json'), 'utf-8');
  const data = JSON.parse(raw) as DemoPresentation;
  return validatePresentation(data, 'demo.json');
}

export function loadPresentation(presentationsDir: string, presentationId: string): DemoPresentation {
  const base = join(presentationsDir, presentationId);
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf-8')) as PresentationManifest;
  const scripts = JSON.parse(readFileSync(join(base, 'scripts.json'), 'utf-8')) as PresentationScripts;
  const kbPath = join(base, 'kb.json');
  let kb: PresentationKb | undefined;
  if (existsSync(kbPath)) {
    kb = JSON.parse(readFileSync(kbPath, 'utf-8')) as PresentationKb;
  }
  const byPage = new Map(scripts.scripts.map((s) => [s.pageNo, s.script]));
  const data: DemoPresentation = {
    presentationId: manifest.presentationId,
    title: manifest.title,
    totalPages: manifest.totalPages,
    deckFile: manifest.deckFile,
    assetBaseUrl: `/api/presentations/${encodeURIComponent(manifest.presentationId)}/assets`,
    ...(manifest.chapters ? { chapters: manifest.chapters } : {}),
    ...(kb?.chunks && kb.chunks.length > 0 ? { kb: kb.chunks } : {}),
    ...(scripts.opening ? { opening: scripts.opening } : {}),
    ...(scripts.closing ? { closing: scripts.closing } : {}),
    pages: manifest.pages.map((p) => ({
      pageNo: p.pageNo,
      title: p.title,
      content: p.content,
      script: byPage.get(p.pageNo) ?? '',
    })),
  };

  // Merge slides-manifest.json if present
  const slidesManifestPath = join(base, 'slides', 'slides-manifest.json');
  if (existsSync(slidesManifestPath)) {
    try {
      const sm = JSON.parse(readFileSync(slidesManifestPath, 'utf-8')) as SlideManifest;
      if (sm.slideImages.length === manifest.totalPages) {
        data.slideImages = sm.slideImages;
        data.slideImagesBaseUrl = `/api/presentations/${encodeURIComponent(manifest.presentationId)}/slides`;
      }
    } catch { /* ignore malformed slides-manifest */ }
  }
  return validatePresentation(data, `presentations/${presentationId}`);
}

export function listPresentations(presentationsDir: string): Array<{
  presentationId: string;
  title: string;
  totalPages: number;
  deckFile?: string;
}> {
  if (!existsSync(presentationsDir)) return [];
  const out: Array<{ presentationId: string; title: string; totalPages: number; deckFile?: string }> = [];
  for (const name of readdirSync(presentationsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    try {
      const p = loadPresentation(presentationsDir, name.name);
      out.push({
        presentationId: p.presentationId,
        title: p.title,
        totalPages: p.totalPages,
        deckFile: p.deckFile,
      });
    } catch {
      // Ignore malformed local presentation directories in the listing.
    }
  }
  return out.sort((a, b) => a.presentationId.localeCompare(b.presentationId));
}
