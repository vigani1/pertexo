import { createServer } from 'node:http';

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
    active++;
    forwarded++;
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(new URL(request.url, target), {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const headers = Object.fromEntries(upstream.headers);
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
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
      const ready = await fetch(new URL('/health/ready', url), {
        signal: AbortSignal.timeout(10_000),
      });
      if (ready.status !== 200)
        throw new Error('Artifact is not ready; traffic remains held');
      target = url;
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
