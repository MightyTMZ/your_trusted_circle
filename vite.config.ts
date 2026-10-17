/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** The only env vars the browser bundle may see. Everything else in .env stays server-side. */
const CLIENT_ENV = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_MAP_ID', 'DEMO_VENUE'] as const;

export default defineConfig(({ mode }) => {
  // .env for local runs; the real environment (e.g. Railway variables) wins.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
    plugins: [react()],
    // Expose these (no VITE_ prefix) to client code.
    define: Object.fromEntries(CLIENT_ENV.map((k) => [`import.meta.env.${k}`, JSON.stringify(env[k] ?? '')])),
    // In development the API (npm run server) is served from the app's own origin,
    // so its sign-in cookie is first-party and the Origin check passes.
    server: {
      proxy: { '/api': { target: `http://localhost:${env.PORT ?? 8787}`, changeOrigin: false } },
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
