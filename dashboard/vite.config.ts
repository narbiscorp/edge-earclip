import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/edge-earclip/',
  define: {
    // Build-time stamp so the running app can prove it's the latest
    // bundle. Visible in the header next to the title.
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
    ),
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
