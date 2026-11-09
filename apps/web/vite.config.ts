import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the UI is served by Vite and API calls are proxied to the local daemon.
// scripts/dev.ts sets ATLAS_DAEMON_URL from the daemon discovery record.
const daemon = process.env.ATLAS_DAEMON_URL ?? 'http://127.0.0.1:4317';

/**
 * Excalidraw (design boards, D03) loads its fonts from `window.EXCALIDRAW_ASSET_PATH`; the UI runs
 * under a `default-src 'self'` CSP with no CDN, so the fonts are served from the app origin: copied
 * into dist/fonts at build and served from node_modules in dev.
 */
function excalidrawAssets(): Plugin {
  const require = createRequire(import.meta.url);
  // the package exports no package.json subpath; its entry sits next to the fonts folder
  const fonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
  return {
    name: 'atlas-excalidraw-assets',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const file = join(fonts, decodeURIComponent((req.url ?? '').split('?')[0] ?? ''));
        if (!file.startsWith(fonts) || !existsSync(file)) return next();
        res.setHeader('content-type', 'font/woff2');
        res.end(require('node:fs').readFileSync(file));
      });
    },
    closeBundle() {
      cpSync(fonts, join(dirname(new URL(import.meta.url).pathname), 'dist/fonts'), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
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
