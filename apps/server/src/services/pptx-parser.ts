import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectLibreOffice } from './pptx-converter.js';
import { logger } from '../logger.js';

export interface PptxPageInfo {
  pageNo: number;
  title: string;
  content: string;
}

export interface PptxParseResult {
  pages: PptxPageInfo[];
  totalPages: number;
}

function findPdftotext(): string | null {
  const candidates = ['/usr/bin/pdftotext', '/usr/local/bin/pdftotext'];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execSync('which pdftotext 2>/dev/null', { timeout: 3000, encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) return result;
  } catch { /* not found */ }
  return null;
}

export function parsePptxPages(pptxPath: string): PptxParseResult {
  const lo = detectLibreOffice();
  if (!lo.available || !lo.path) {
    throw new Error('LibreOffice not available — cannot parse pptx pages');
  }

  const pdftotextPath = findPdftotext();
  if (!pdftotextPath) {
    throw new Error('pdftotext not available — install poppler-utils');
  }

  const tmpDir = join(tmpdir(), `pptx-parse-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Step 1: PPTX -> PDF
    execSync(
      `"${lo.path}" --headless --convert-to pdf --outdir "${tmpDir}" "${pptxPath}"`,
      { timeout: 60_000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );

    const pptxBasename = pptxPath.split('/').pop()!;
    const pdfBaseName = pptxBasename.replace(/\.pptx$/i, '.pdf');
    const pdfFile = join(tmpDir, pdfBaseName);

    if (!existsSync(pdfFile)) {
      const alt = join(tmpDir, pdfBaseName.toLowerCase());
      if (!existsSync(alt)) {
        throw new Error('PDF output not found after LibreOffice conversion');
      }
    }

    const actualPdf = existsSync(join(tmpDir, pdfBaseName))
      ? join(tmpDir, pdfBaseName)
      : join(tmpDir, pdfBaseName.toLowerCase());

    // Step 2: Extract text per page using pdftotext with -layout and page range
    // pdftotext doesn't support per-page extraction directly, so we extract all
    // text and split by page boundaries using form feed (\x0c)
    execSync(`"${pdftotextPath}" -layout "${actualPdf}" "${join(tmpDir, 'text.txt')}"`, {
      timeout: 30_000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const textContent = readFileSync(join(tmpDir, 'text.txt'), 'utf-8');

    // Split text by page: pdftotext with -layout outputs pages separated by form feed (\x0c)
    const pageTexts = textContent.split('\x0c').filter((t: string) => t.trim().length > 0);

    const pages: PptxPageInfo[] = pageTexts.map((pageText: string, i: number) => {
      const lines = pageText.trim().split('\n').filter((l: string) => l.trim().length > 0);
      const title = lines[0]?.trim() || `第 ${i + 1} 页`;
      const content = lines.slice(1).join('\n').trim() || title;
      return { pageNo: i + 1, title, content };
    });

    if (pages.length === 0) {
      throw new Error('Could not extract per-page text from PDF');
    }

    logger.info('pptx parsed', { pptxPath, totalPages: pages.length });
    return { pages, totalPages: pages.length };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}