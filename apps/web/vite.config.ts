import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxyTarget =
  process.env.PERTEXO_API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const parsedApiProxyTarget = new URL(apiProxyTarget);
if (
  !['http:', 'https:'].includes(parsedApiProxyTarget.protocol) ||
  parsedApiProxyTarget.username !== '' ||
  parsedApiProxyTarget.password !== '' ||
  parsedApiProxyTarget.pathname !== '/' ||
  parsedApiProxyTarget.search !== '' ||
  parsedApiProxyTarget.hash !== ''
) {
  throw new Error('PERTEXO_API_PROXY_TARGET must be an HTTP(S) origin');
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: parsedApiProxyTarget.origin,
        changeOrigin: false,
      },
    },
  },
  build: { target: 'es2022' },
});
