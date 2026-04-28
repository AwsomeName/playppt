import { describe, expect, it, vi, beforeEach } from 'vitest';
import { detectLibreOffice, checkSlidesCache } from './pptx-converter.js';

// Mock node:fs for tests
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  rm: vi.fn(),
  mkdtemp: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: {
    pptxConvertTimeoutMs: 60000,
    pptxConvertDpi: 150,
    libreOfficeConvertEnabled: true,
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const fs = await import('node:fs');
const cp = await import('node:child_process');

describe('detectLibreOffice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unavailable when no soffice found', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (cp.execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not found');
    });
    const result = detectLibreOffice();
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
  });

  it('returns available when soffice in known path', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p === '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    );
    const result = detectLibreOffice();
    expect(result.available).toBe(true);
    expect(result.path).toBe('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  });
});

describe('checkSlidesCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when slides-manifest.json does not exist', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = checkSlidesCache('/some/slides', 12);
    expect(result).toBeNull();
  });

  it('returns file list when cache is valid', () => {
    const manifest = {
      slideImages: Array.from({ length: 12 }, (_, i) => ({
        pageNo: i + 1,
        file: `slide-${i + 1}.png`,
      })),
      convertedAt: '2026-04-27T00:00:00Z',
      sourceDeckFile: 'deck.pptx',
      totalPages: 12,
    };
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('slides-manifest.json') || p.endsWith('.png'),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(manifest));
    const result = checkSlidesCache('/some/slides', 12);
    expect(result).toEqual(manifest.slideImages.map((e) => e.file));
  });

  it('returns null when file count mismatches totalPages', () => {
    const manifest = {
      slideImages: [{ pageNo: 1, file: 'slide-1.png' }],
      convertedAt: '2026-04-27T00:00:00Z',
      sourceDeckFile: 'deck.pptx',
      totalPages: 1,
    };
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('slides-manifest.json') || p.endsWith('.png'),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(manifest));
    const result = checkSlidesCache('/some/slides', 12);
    expect(result).toBeNull();
  });
});