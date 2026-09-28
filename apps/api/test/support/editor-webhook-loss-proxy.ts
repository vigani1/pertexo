import { createServer, request, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';

/** One test-owned endpoint, one post-commit lost acknowledgement; never a router. */
export function createEditorWebhookLossProxy(
  apiOrigin: string,
  endpointKey: string,
  assertCommitted: (runId: string) => Promise<void>,
) {
  const upstream = new URL(apiOrigin);
  if (
    upstream.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(upstream.hostname) ||
    !/^\d{1,5}$/u.test(upstream.port) ||
    upstream.pathname !== '/' ||
    upstream.search !== '' ||
    upstream.username !== '' ||
    upstream.password !== '' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(endpointKey)
  )
    throw new Error('Owned webhook proxy configuration invalid');
  const path = `/hooks/${endpointKey}`;
  const sockets = new Set<Socket>();
  const exchanges = new Set<ClientRequest>();
  let stopped = false;
  let lossClaimed = false;
  let lostRunId: string | undefined;
  let firstTimestamp: string | undefined;
  let origin: string | undefined;
  let startup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer(
    { maxHeaderSize: 8_192 },
    (incoming, outgoing) => {
      const exchangeDisposed = () => stopped || outgoing.destroyed;
      void (async () => {
        try {
          if (stopped || incoming.method !== 'POST' || incoming.url !== path) {
            outgoing.writeHead(404).end();
            return;
          }
          const values = [
            'content-type',
            'idempotency-key',
            'x-pertexo-timestamp',
            'x-pertexo-signature',
          ].map((key) => incoming.headers[key]);
          const [media, key, timestamp, signature] = values;
          if (
            media !== 'application/json' ||
            typeof key !== 'string' ||
            !/^[!-~]{1,128}$/u.test(key) ||
            key.includes(',') ||
            typeof timestamp !== 'string' ||
            !/^\d{1,16}$/u.test(timestamp) ||
            typeof signature !== 'string' ||
            !/^v1=[a-f0-9]{64}$/u.test(signature)
          ) {
            outgoing.writeHead(400).end();
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const raw of incoming) {
            const chunk = Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw as Uint8Array);
            length += chunk.length;
            if (length > 4_096) {
              outgoing.writeHead(413).end();
              incoming.destroy();
              return;
            }
            chunks.push(chunk);
          }
          if (exchangeDisposed()) return;
          const body = Buffer.concat(chunks);
          const reply = await new Promise<{ status: number; body: Buffer }>(
            (resolve, reject) => {
              let settled = false;
              let collected = 0;
              const bytes: Buffer[] = [];
              const fail = () => {
                if (!settled) {
                  settled = true;
                  reject(new Error('Owned webhook upstream unavailable'));
                }
                forward.destroy();
              };
              const forward = request(
                {
                  hostname: upstream.hostname,
                  port: upstream.port,
                  path,
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'content-length': body.length,
                    'idempotency-key': key,
                    'x-pertexo-timestamp': timestamp,
                    'x-pertexo-signature': signature,
                  },
                },
                (response) => {
                  response.on('data', (chunk: Buffer) => {
                    collected += chunk.length;
                    if (collected > 4_096) {
                      response.destroy();
                      fail();
                      return;
                    }
                    bytes.push(chunk);
                  });
                  response.once('error', fail);
                  response.once('aborted', fail);
                  response.once('end', () => {
                    if (!settled) {
                      settled = true;
                      resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(bytes),
                      });
                    }
                  });
                },
              );
              exchanges.add(forward);
              forward.once('close', () => exchanges.delete(forward));
              forward.setTimeout(5_000, fail);
              forward.once('error', fail);
              if (stopped) {
                fail();
                return;
              }
              forward.end(body);
            },
          );
          if (exchangeDisposed()) return;
          if (reply.status === 202 && !lossClaimed) {
            lossClaimed = true; // Fence a competing request before awaiting SQL.
            const parsed = z
              .strictObject({ runId: z.uuid(), replayed: z.literal(false) })
              .parse(JSON.parse(reply.body.toString('utf8')));
            await assertCommitted(parsed.runId);
            if (exchangeDisposed()) return;
            lostRunId = parsed.runId;
            firstTimestamp = timestamp;
            outgoing.destroy(); // Only after the actual API returned a durable 202.
            return;
          }
          outgoing.writeHead(reply.status, {
            'content-type': 'application/json',
          });
          outgoing.end(reply.body);
        } catch {
          // No raw causes, endpoint paths, signatures or upstream headers in errors.
          if (!outgoing.destroyed)
            outgoing.writeHead(502).end('{"code":"owned_exchange_failed"}');
        }
      })();
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    start() {
      if (stopped)
        return Promise.reject(new Error('Owned webhook proxy disposed'));
      startup ??= new Promise<void>((resolve, reject) => {
        server.once('error', () => {
          reject(new Error('Owned webhook proxy startup failed'));
        });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (stopped || address === null || typeof address === 'string') {
            reject(new Error('Owned webhook proxy startup unavailable'));
            return;
          }
          origin = `http://127.0.0.1:${String(address.port)}`;
          resolve();
        });
      });
      return startup;
    },
    origin() {
      if (origin === undefined || stopped)
        throw new Error('Owned webhook proxy unavailable');
      return origin;
    },
    observe() {
      return {
        lostRunId,
        firstTimestamp,
        openExchanges: exchanges.size,
        sockets: sockets.size,
      };
    },
    close() {
      stopped = true;
      closing ??= (async () => {
        await startup?.catch(() => undefined);
        for (const exchange of exchanges) exchange.destroy();
        for (const socket of sockets) socket.destroy();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(new Error('Owned webhook proxy shutdown failed'));
            }),
          );
      })();
      return closing;
    },
  };
}
