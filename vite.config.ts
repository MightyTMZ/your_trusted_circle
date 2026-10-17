/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The YTC backend (npm run server). Keys stay there; the browser only sees /api.
    proxy: { '/api': `http://127.0.0.1:${process.env.YTC_SERVER_PORT ?? 8787}` },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
