import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { ensureSlidesConverted, detectLibreOffice } from '../services/pptx-converter.js';

const args = process.argv.slice(2);
let presentationId = 'demo';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--presentation' && args[i + 1]) {
    presentationId = args[i + 1];
    i++;
  }
}

const lo = detectLibreOffice();
if (!lo.available) {
  console.error('LibreOffice 未安装。请先安装：');
  console.error('  macOS: brew install --cask libreoffice && brew install poppler');
  console.error('  Linux: apt-get install libreoffice-core libreoffice-impress poppler-utils');
  process.exit(1);
}

console.log(`检测到 LibreOffice: ${lo.path}`);

const manifestPath = join(config.presentationsDir, presentationId, 'manifest.json');
let manifest: { deckFile?: string; totalPages: number };
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch (e) {
  console.error(`无法读取 manifest.json: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (!manifest.deckFile) {
  console.error('manifest.json 中未指定 deckFile，无需转换。');
  process.exit(0);
}

const pptxPath = join(config.presentationsDir, presentationId, manifest.deckFile);
const slidesDir = join(config.presentationsDir, presentationId, 'slides');

console.log(`开始转换演示稿: ${presentationId} (${manifest.deckFile})`);
const result = await ensureSlidesConverted(pptxPath, slidesDir, manifest.totalPages);

if (result.ok) {
  console.log(`转换成功，共 ${result.slideFiles.length} 张幻灯片图片`);
  console.log(`输出目录: ${slidesDir}`);
} else {
  console.error(`转换失败: ${result.error}`);
  process.exit(1);
}