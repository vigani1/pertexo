import { createServer, request as requestLoopback } from 'node:http';

/** Actual loopback HTTP admission: held requests never reach an API process. */
export async function createCuratedCutoverTraffic() {
  let held = true,
    target,
    active = 0,
    forwarded = 0;
  const drains = new Set();
  const server = createServer((request, response) => {
    if (held || target === undefined) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'traffic_held' }));
      return;
    }
    if (
      typeof request.url !== 'string' ||
      !request.url.startsWith('/') ||
      request.url.startsWith('//') ||
      request.url.includes('\\') ||
      Array.from(request.url).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 32 || code === 127;
      })
    ) {
      response.writeHead(400);
      response.end();
      return;
    }
    active++;
    forwarded++;
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await new Promise((resolve, reject) => {
        // Incoming targets are paths only. The transport host is fixed, never
        // derived from request data or URL resolution (including // targets).
        const outgoing = requestLoopback(
          {
            hostname: '127.0.0.1',
            port: target,
            path: request.url,
            method: request.method,
            headers: request.headers,
            signal: AbortSignal.timeout(10_000),
          },
          resolve,
        );
        outgoing.once('error', reject);
        outgoing.end(chunks.length ? Buffer.concat(chunks) : undefined);
      });
      const body = [];
      for await (const chunk of upstream) body.push(chunk);
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      response.end(Buffer.concat(body));
    })()
      .catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      })
      .finally(() => {
        active--;
        if (active === 0) {
          for (const resolve of drains) resolve();
          drains.clear();
        }
      });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    snapshot: () => ({ held, active, forwarded, target }),
    async hold() {
      held = true;
      if (active === 0) return;
      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => drains.add(resolve)),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Owned traffic drain exceeded5s')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async release(url) {
      if (!held) throw new Error('Traffic release requires held state');
      if (
        typeof url !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(url)
      )
        throw new Error('Traffic requires an explicit loopback API target');
      const port = Number(url.slice('http://127.0.0.1:'.length));
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Traffic requires an explicit loopback API port');
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (ready.status !== 200)
        throw new Error('Artifact is not ready; traffic remains held');
      target = port;
      held = false;
    },
    close: () =>
      new Promise((resolve, reject) => {
        held = true;
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
