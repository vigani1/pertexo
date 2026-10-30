// @vitest-environment node
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import { expect, it, vi } from 'vitest';
import config from '../../vite.config';
import { mockServer } from '../support/mock-server';

it('forwards local webhook bodies and preflight, redacting credential URLs on upstream failure', async () => {
  mockServer.close();
  const received: {
    method: string | undefined;
    url: string | undefined;
    body: string;
  }[] = [];
  const upstream = createHttpServer((request, response) => {
    // Other software probes new local ports (T3 Code's desktop app sends
    // `GET /`). Those aren't requests the proxy forwarded.
    if (request.url?.startsWith('/hooks/') !== true) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(request.method === 'OPTIONS' ? 204 : 202, {
        'content-type': 'application/json',
      });
      response.end(
        request.method === 'OPTIONS' ? undefined : '{"captured":true}',
      );
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (address === null || typeof address === 'string')
    throw new Error('No upstream address');
  const target = `http://127.0.0.1:${String(address.port)}`;
  const server = await createServer({
    ...config,
    configFile: false,
    plugins: [],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: Object.fromEntries(
        Object.entries(config.server?.proxy ?? {}).map(([path, options]) => [
          path,
          { ...(typeof options === 'string' ? {} : options), target },
        ]),
      ),
    },
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await server.listen();
    const web = server.httpServer?.address();
    if (web === null || web === undefined || typeof web === 'string')
      throw new Error('No web proxy address');
    const origin = `http://127.0.0.1:${String(web.port)}`;
    const path = `/hooks/${'a'.repeat(43)}/test?private=sample`;
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"amount":17}',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ captured: true });
    expect((await fetch(origin + path, { method: 'OPTIONS' })).status).toBe(
      204,
    );
    expect(received).toEqual([
      { method: 'POST', url: path, body: '{"amount":17}' },
      { method: 'OPTIONS', url: path, body: '' },
    ]);
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    expect((await fetch(origin + path, { method: 'POST' })).status).toBe(502);
    const messages = logged.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(messages).toContain('/hooks/[redacted]');
    expect(messages).not.toContain('a'.repeat(43));
    expect(messages).not.toContain('private=sample');
  } finally {
    await server.close();
    if (upstream.listening)
      await new Promise<void>((resolve) =>
        upstream.close(() => {
          resolve();
        }),
      );
    logged.mockRestore();
  }
});
