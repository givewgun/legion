import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where to forward /api. Defaults to the host legion-api for local dev; in
// containers it's overridden to the api service (LEGION_API_PROXY=http://api:8088).
const apiProxy = process.env.LEGION_API_PROXY || 'http://localhost:8088';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': apiProxy }, // dev server
  },
  // `vite preview` is no longer used in production (nginx serves the build).
  // Kept only so `npm run preview` works for a local production-bundle check.
  preview: {
    port: 5174,
    proxy: { '/api': apiProxy },
    allowedHosts: ['legion.givewgun.com'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.js',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      reporter: ['text', 'json', 'json-summary'],
    },
  },
});
