import { createServer } from 'node:http';
import { once } from 'node:events';

export async function createPagedFileSource() {
  const authorization = 'Bearer owned-paged-file-source';
  const rows = Array.from({ length: 7200 }, (_, id) => ({
    id,
    text: 'a'.repeat(150),
    echo: authorization,
  }));
  const received: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorization) {
      response.writeHead(403).end();
      return;
    }
    const page = Number(
      new URL(request.url ?? '/', 'http://localhost').searchParams.get(
        'page',
      ) ?? 1,
    );
    received.push(request.headers.authorization);
    const data = rows.slice((page - 1) * 900, page * 900);
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        data,
        next: page < 8 ? `?page=${String(page + 1)}` : null,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing source address');
  return {
    authorization,
    received,
    rows: rows.map((row) => ({ ...row, echo: '[Redacted]' })),
    url: `http://127.0.0.1:${String(address.port)}/items`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        }),
      );
    },
  };
}
