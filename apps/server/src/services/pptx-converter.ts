import { execSync } from 'node:child_process';
import { copyFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SlideManifest } from '../types/presentation.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface SlideConversionResult {
  ok: boolean;
  slideFiles: string[];
  error?: string;
}

export interface LibreOfficeDetection {
  available: boolean;
  path: string | null;
}

export function detectLibreOffice(): LibreOfficeDetection {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/libreoffice',
    '/snap/bin/libreoffice',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { available: true, path: p };
  }
  try {
    const result = execSync('which soffice 2>/dev/null || which libreoffice 2>/dev/null', {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();
    if (result && existsSync(result)) return { available: true, path: result };
  } catch { /* not in PATH */ }
  return { available: false, path: null };
}

function findPdftoppm(): string | null {
  const candidates = ['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm'];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execSync('which pdftoppm 2>/dev/null', { timeout: 3000, encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) return result;
  } catch { /* not found */ }
  return null;
}

function execWithTimeout(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const timeout = options?.timeoutMs ?? config.pptxConvertTimeoutMs;
  try {
    const result = execSync(`${command} ${args.map((a) => `"${a}"`).join(' ')}`, {
      timeout,
      cwd: options?.cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number; killed?: boolean };
    if (err.killed) {
      return { stdout: '', stderr: 'process timed out', exitCode: -1 };
    }
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

export function checkSlidesCache(slidesDir: string, totalPages: number): string[] | null {
  const manifestPath = join(slidesDir, 'slides-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const sm = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SlideManifest;
    if (sm.slideImages.length !== totalPages) return null;
    const files = sm.slideImages.map((e) => e.file);
    for (const f of files) {
      if (!existsSync(join(slidesDir, f))) return null;
    }
    return files;
  } catch { return null; }
}

async function convertPptxToImages(
  pptxPath: string,
  slidesDir: string,
): Promise<SlideConversionResult> {
  const lo = detectLibreOffice();
  if (!lo.available || !lo.path) {
    return { ok: false, error: 'LibreOffice not available', slideFiles: [] };
  }

  const pdftoppmPath = findPdftoppm();
  if (!pdftoppmPath) {
    return { ok: false, error: 'pdftoppm not available (install poppler-utils)', slideFiles: [] };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'pptx-convert-'));

  try {
    // Step 1: PPTX -> PDF
    const pdfResult = execWithTimeout(lo.path, [
      '--headless', '--convert-to', 'pdf', '--outdir', tmpDir, pptxPath,
    ]);
    if (pdfResult.exitCode !== 0) {
      return { ok: false, error: `LibreOffice conversion failed: ${pdfResult.stderr}`, slideFiles: [] };
    }

    const pdfBaseName = pptxPath.replace(/\.pptx$/i, '').split('/').pop()! + '.pdf';
    const pdfFile = join(tmpDir, pdfBaseName);
    if (!existsSync(pdfFile)) {
      // try lowercase variant
      const alt = join(tmpDir, pdfBaseName.toLowerCase());
      if (!existsSync(alt)) {
        return { ok: false, error: 'PDF output not found after LibreOffice conversion', slideFiles: [] };
      }
    }

    // Step 2: PDF -> PNG (per page)
    const ppmResult = execWithTimeout(pdftoppmPath, [
      '-png', '-r', String(config.pptxConvertDpi), pdfFile, join(tmpDir, 'slide'),
    ]);
    if (ppmResult.exitCode !== 0) {
      return { ok: false, error: `pdftoppm conversion failed: ${ppmResult.stderr}`, slideFiles: [] };
    }

    // Collect generated PNG files (pdftoppm outputs slide-1.png, slide-01.png, etc.)
    const tmpFiles = readdirSync(tmpDir)
      .filter((f: string) => /^slide-?\d+\.png$/i.test(f))
      .sort((a: string, b: string) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? '0', 10);
        const nb = parseInt(b.match(/\d+/)?.[0] ?? '0', 10);
        return na - nb;
      });

    await mkdir(slidesDir, { recursive: true });
    const slideFiles: string[] = [];
    for (const f of tmpFiles) {
      const targetName = `slide-${slideFiles.length + 1}.png`;
      await copyFile(join(tmpDir, f), join(slidesDir, targetName));
      slideFiles.push(targetName);
    }

    return { ok: true, slideFiles };
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function ensureSlidesConverted(
  pptxPath: string,
  slidesDir: string,
  totalPages: number,
): Promise<SlideConversionResult> {
  if (!config.libreOfficeConvertEnabled) {
    return { ok: false, error: 'PPTX conversion disabled by config', slideFiles: [] };
  }

  const cached = checkSlidesCache(slidesDir, totalPages);
  if (cached) return { ok: true, slideFiles: cached };

  if (!existsSync(pptxPath)) {
    return { ok: false, error: `pptx file not found: ${pptxPath}`, slideFiles: [] };
  }

  const result = await convertPptxToImages(pptxPath, slidesDir);
  if (result.ok) {
    const manifest: SlideManifest = {
      slideImages: result.slideFiles.map((f, i) => ({ pageNo: i + 1, file: f })),
      convertedAt: new Date().toISOString(),
      sourceDeckFile: pptxPath.split('/').pop()!,
      totalPages,
    };
    await mkdir(slidesDir, { recursive: true });
    writeFileSync(join(slidesDir, 'slides-manifest.json'), JSON.stringify(manifest, null, 2));
    logger.info('slides conversion completed', { totalPages, slideCount: result.slideFiles.length });
  } else {
    logger.warn('slides conversion failed', { error: result.error });
  }
  return result;
}