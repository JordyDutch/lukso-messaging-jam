import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static build. Root-hosted by default; set VITE_BASE to the sub-path when
// serving behind a reverse proxy (e.g. GitHub Pages uses "/<repo>/").
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
