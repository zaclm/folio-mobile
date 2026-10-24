// Vite build for the phone app (Capacitor). Same index.html and src/ as the desktop app;
// this config swaps the entry script, the CSP and the viewport for the mobile shell.
import { defineConfig } from 'vite';

// Capacitor injects its native bridge as an inline <script> when it serves index.html,
// so script-src needs 'unsafe-inline' here (desktop keeps 'self' only). Documents still
// can't run code: rendered markdown always goes through DOMPurify (security rule 4).
const MOBILE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ') + ';';

function mobileShell() {
  return {
    name: 'folio-mobile-shell',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
      const out = html
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${MOBILE_CSP}" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=auto" />
    <meta name="color-scheme" content="light dark" />`)
        .replace('<html lang="en" data-theme="light">', '<html lang="en" data-theme="light" class="mobile">')
        .replace('src="./src/main.js"', 'src="./mobile/entry.js"');
      if (!out.includes('./mobile/entry.js') || !out.includes('viewport')) throw new Error('mobile shell: index.html changed, update vite.mobile.config.js');
      return out;
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [mobileShell()],
  define: { __FOLIO_MOBILE__: 'true' },
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    target: ['chrome100'],
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5174, strictPort: true },
});
