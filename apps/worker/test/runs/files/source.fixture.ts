import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Busboy } from '@fastify/busboy';

export function dataset(count: number, paddedBytes: number) {
  const rows = Array.from({ length: count }, (_, id) => ({
    id,
    text: 'a'.repeat(45),
    currency: 'EUR',
    amount: 2,
  }));
  const json = Buffer.from(JSON.stringify(rows));
  const csv = Buffer.from(
    'id,text,currency,amount\r\n' +
      rows.map((row) => `${String(row.id)},${row.text},EUR,2\r\n`).join(''),
  );
  if (json.length > paddedBytes || csv.length > paddedBytes)
    throw new Error('Fixture exceeds ceiling');
  return {
    rows,
    json: Buffer.concat([json, Buffer.alloc(paddedBytes - json.length, 32)]),
    csv: Buffer.concat([csv, Buffer.alloc(paddedBytes - csv.length, 10)]),
    expected: {
      bytes: json.length,
      sha256: createHash('sha256').update(json).digest('hex'),
    },
  };
}

export async function fileReceiver(rows: readonly unknown[]) {
  const received: {
    kind: string;
    bytes: number;
    sha256: string;
    parts: number;
  }[] = [];
  let release: (() => void) | undefined;
  let gate = Promise.resolve();
  let pending = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/items') {
        const page = Number(url.searchParams.get('page') ?? 0);
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            data: rows.slice(page * 1000, (page + 1) * 1000),
            next:
              (page + 1) * 1000 < rows.length
                ? `?page=${String(page + 1)}`
                : null,
          }),
        );
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/raw', '/multipart'].includes(url.pathname)
      ) {
        response.writeHead(404).end();
        return;
      }
      pending++;
      await gate;
      pending--;
      const observation = {
        kind: url.pathname,
        bytes: 0,
        sha256: '',
        parts: 0,
      };
      const hash = createHash('sha256');
      if (url.pathname === '/multipart') {
        const parser = new Busboy({
          headers: { 'content-type': request.headers['content-type'] ?? '' },
          isPartAFile: () => true,
          limits: { parts: 64, files: 64, fileSize: 10485760 },
        });
        parser.on('file', (name, stream) => {
          observation.parts++;
          stream.on('data', (chunk: Buffer) => {
            if (name === 'file') {
              observation.bytes += chunk.length;
              hash.update(chunk);
            }
          });
          stream.on('error', (error) => parser.destroy(error));
        });
        await pipeline(request, parser);
      } else {
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk))
            throw new Error('Receiver requires bytes');
          observation.bytes += chunk.length;
          hash.update(chunk);
        }
      }
      observation.sha256 = hash.digest('hex');
      received.push(observation);
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(observation));
    })().catch(() => {
      response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Receiver did not bind');
  return {
    get pending() {
      return pending;
    },
    origin: `http://127.0.0.1:${String(address.port)}`,
    received,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
    },
    async close() {
      release?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  };
}
