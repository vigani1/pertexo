import { initializeAppearance } from './src/lib/appearance/bootstrap.ts';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

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

const logger = createLogger();
const logError = logger.error.bind(logger);
// Proxy outages must not print a Secret URL credential or its query string.
logger.error = (message, options) => {
  logError(
    message.replaceAll(/\/hooks\/[^\s]+/gu, '/hooks/[redacted]'),
    options,
  );
};

export default defineConfig({
  customLogger: logger,
  plugins: [
    {
      name: 'appearance-before-paint',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [
          {
            tag: 'script',
            children: `(${initializeAppearance.toString()})()`,
            injectTo: 'head',
          },
        ],
      },
    },
    react(),
    tailwindcss(),
  ],

  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // The API owns webhook CORS, including OPTIONS; Vite must forward it.
    cors: false,
    port: 5173,
    strictPort: true,
    proxy: {
      '/hooks': { target: parsedApiProxyTarget.origin, changeOrigin: false },
      '/v1': {
        target: parsedApiProxyTarget.origin,
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Keep the runtime cached when application routes change.
              name: 'react-runtime',
              test: /node_modules[\\/](?:(?:react|react-dom|scheduler)[\\/]|@tanstack[\\/](?:react-router|router-core|history|react-query|query-core|react-store|store)[\\/])/u,
            },
          ],
        },
      },
    },
  },
});
