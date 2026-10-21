import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served behind the :8443 VPN reverse proxy at /app/.
// Override with VITE_BASE='/' for a root-hosted or local `vite preview` build.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/app/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
