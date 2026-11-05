import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/.cache/**'] } },
  optimizeDeps: { entries: ['index.html'], include: ['onnxruntime-web/webgpu'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
