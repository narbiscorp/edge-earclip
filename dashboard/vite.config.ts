import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

// Best-effort git short SHA. Falls back to 'nogit' if git isn't on PATH or
// the build is happening outside a working tree (e.g. tarball deploys).
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'nogit';
  }
}

export default defineConfig({
  plugins: [react()],
  base: '/edge-earclip/',
  define: {
    // Build-time stamp so the running app can prove it's the latest bundle.
    // Format: <utc-yyyymmddhhmmss>-<git-short-sha>. Visible in the header
    // — compare to `git log --oneline -1` to verify which commit you're on.
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) +
        '-' + gitShortSha(),
    ),
  },
  build: {
    rollupOptions: {
      // Multi-page build. `index.html` is the dashboard (the deploy step renames
      // it to app.html so the hub can own the root URL); `respiration.html` is
      // the Respiration Analysis tool, which shares this project so it can use
      // the real Coherence Engine, metrics worker and Polar H10 driver rather
      // than a second copy of each.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        respiration: fileURLToPath(new URL('./respiration.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      'buffer/': 'buffer',
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
});
