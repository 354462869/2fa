import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content.ts',
      formats: ['es'],
      fileName: () => 'content.js'
    },
    rollupOptions: {
      output: {
        entryFileNames: 'content.js'
      }
    }
  }
});
