import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo, /graphql se reenvia al API Gateway del ambiente elegido:
//   AEGIS_API=http://<apiId>.execute-api.localhost.floci.io:4566 npm run dev
// En el cluster, nginx sirve el build y API Gateway enruta /graphql al gateway
// (mismo origen: sin CORS).
const target = process.env.AEGIS_API ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': { target, changeOrigin: true },
      '/flags': { target, changeOrigin: true },
      // Config de runtime (peers para comparar flags) la sirve el frontend desplegado.
      '/runtime': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
