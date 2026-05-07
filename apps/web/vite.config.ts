import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget =
    (process.env.VITE_API_BASE && process.env.VITE_API_BASE.trim()) ||
    env.VITE_API_BASE ||
    'http://localhost:3001';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
    /** 与 `npm run start`（vite preview）配合后端同机常驻时，需同样转发 /api */
    preview: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
    },
  };
});
