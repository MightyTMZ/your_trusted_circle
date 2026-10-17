/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // In development the API (npm run server) is served from the app's own origin,
  // so its sign-in cookie is first-party and the Origin check passes.
  server: {
    proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? 8787}`, changeOrigin: false } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
