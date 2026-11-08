import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The Tauri shell points its webview at a fixed dev origin, so the port is not
// allowed to drift and the Rust target folder must stay out of the watcher.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
