/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served behind the :8443 VPN reverse proxy at /app/.
  // Override with VITE_BASE='/' for a root-hosted / local `vite preview` build.
  base: process.env.VITE_BASE ?? '/app/',
  // ethers v6 is ESM and browser-ready; no node polyfills needed.
  // @noble/* are pure JS and run in the browser unchanged.
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
