import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:8088' }, // legion-api
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.js',
  },
});
