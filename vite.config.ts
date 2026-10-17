/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Expose Google Maps env vars (no VITE_ prefix) to client code.
  define: {
    'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(process.env.GOOGLE_MAPS_API_KEY ?? ''),
    'import.meta.env.GOOGLE_MAPS_MAP_ID': JSON.stringify(process.env.GOOGLE_MAPS_MAP_ID ?? ''),
  },
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
