import { describe, expect, it } from 'vitest';

import type { PresentationManifest, PresentationScripts } from '../types/presentation.js';
import { validateScriptsAgainstManifest } from './presentation-files.js';

describe('presentation-files validation', () => {
  const manifest: PresentationManifest = {
    presentationId: 'x',
    title: 't',
    totalPages: 2,
    pages: [
      { pageNo: 1, title: 'a', content: 'c1' },
      { pageNo: 2, title: 'b', content: 'c2' },
    ],
  };

  it('validateScriptsAgainstManifest accepts complete scripts', () => {
    const scripts: PresentationScripts = {
      scripts: [
        { pageNo: 1, script: 's1' },
        { pageNo: 2, script: 's2' },
      ],
    };
    expect(validateScriptsAgainstManifest(manifest, scripts)).toBeNull();
  });

  it('validateScriptsAgainstManifest rejects empty script', () => {
    const scripts: PresentationScripts = {
      scripts: [
        { pageNo: 1, script: 's1' },
        { pageNo: 2, script: '   ' },
      ],
    };
    expect(validateScriptsAgainstManifest(manifest, scripts)).toContain('不能为空');
  });
});
