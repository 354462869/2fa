import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: 'popup.html'
      }
    }
  },
  test: {
    exclude: ['**/e2e/**', '**/node_modules/**', '**/dist/**']
  }
});
