import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/edge-earclip/',
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
