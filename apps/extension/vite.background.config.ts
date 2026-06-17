import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/background.ts',
      formats: ['es'],
      fileName: () => 'background.js'
    },
    rollupOptions: {
      output: {
        entryFileNames: 'background.js'
      }
    }
  }
});
