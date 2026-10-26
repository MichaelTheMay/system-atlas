import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the UI is served by Vite and API calls are proxied to the local daemon.
// scripts/dev.ts sets ATLAS_DAEMON_URL from the daemon discovery record.
const daemon = process.env.ATLAS_DAEMON_URL ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: daemon, changeOrigin: true },
      '/healthz': { target: daemon, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
