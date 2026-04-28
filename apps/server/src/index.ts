import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { detectLibreOffice } from './services/pptx-converter.js';
import { loadDemoPresentation, loadPresentation } from './demo-loader.js';
import { logger } from './logger.js';
import { apiRouter } from './routes/api.js';

function loadDemoForHealth() {
  try {
    return loadPresentation(config.presentationsDir, 'demo');
  } catch {
    return loadDemoPresentation(`${config.rootDir}/fixtures`);
  }
}

const demo = loadDemoForHealth();

const app = express();
app.use(cors());
app.use(express.json());

const startedAt = Date.now();

app.use('/api', apiRouter);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    libreOfficeAvailable: detectLibreOffice().available,
    demo: {
      presentationId: demo.presentationId,
      totalPages: demo.totalPages,
      title: demo.title,
      deckFile: demo.deckFile ?? null,
    },
  });
});

app.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    env: config.nodeEnv,
    demoPresentationId: demo.presentationId,
    demoTotalPages: demo.totalPages,
  });
});
