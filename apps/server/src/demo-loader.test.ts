import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listPresentations, loadDemoPresentation, loadPresentation } from './demo-loader.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = join(rootDir, 'fixtures');
const presentationsDir = join(rootDir, 'presentations');

describe('loadDemoPresentation', () => {
  it('loads demo.json with consistent page count', () => {
    const demo = loadDemoPresentation(fixturesDir);
    expect(demo.presentationId).toBe('demo');
    expect(demo.pages.length).toBeGreaterThanOrEqual(10);
    expect(demo.totalPages).toBe(demo.pages.length);
  });
});

describe('loadPresentation', () => {
  it('loads manifest + scripts from presentation directory', () => {
    const demo = loadPresentation(presentationsDir, 'demo');
    expect(demo.presentationId).toBe('demo');
    expect(demo.deckFile).toBe('deck.pptx');
    expect(demo.assetBaseUrl).toContain('/api/presentations/demo/assets');
    expect(demo.pages.length).toBeGreaterThanOrEqual(10);
    expect(demo.pages[0]!.script).toContain('欢迎来到');
    expect(demo.kb?.some((k) => k.id === 'project-overview')).toBe(true);
  });

  it('lists valid presentation directories', () => {
    const all = listPresentations(presentationsDir);
    expect(all.some((x) => x.presentationId === 'demo')).toBe(true);
  });
});
