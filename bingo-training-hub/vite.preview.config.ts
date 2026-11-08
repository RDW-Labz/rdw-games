// Demo preview build: one self-contained HTML file running on demo data.
// npx vite build --config vite.preview.config.ts  →  dist-preview/index.html
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    'import.meta.env.VITE_EMBED': JSON.stringify('1'),
  },
  build: { outDir: 'dist-preview', emptyOutDir: true },
});
