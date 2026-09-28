import { createServer, request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import {
  SecureHttpClient,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
} from '@pertexo/integrations/server';

export const controlledActionUrl =
  'https://pertexo-controlled-action.example.test/effect';
const logicalHost = new URL(controlledActionUrl).hostname;
const publicTestAddress = '8.8.8.8';
const maximumBytes = 4_096;

/** One owned real server; only this test transport can map the logical target. */
export function createEditorControlledHttpTarget(
  authorizationValue: string,
  beforeResponse: () => Promise<void> = () => Promise.resolve(),
  onEffect: () => void = () => undefined,
) {
  const authorization = Buffer.from(authorizationValue);
  const bodies: string[] = [];
  const sockets = new Set<Socket>();
  let requests = 0;
  let stopped = false;
  let port: number | undefined;
  let startup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer((incoming, outgoing) => {
    const responseDisposed = () => stopped || outgoing.destroyed;
    requests++;
    void (async () => {
      try {
        if (
          stopped ||
          incoming.method !== 'POST' ||
          incoming.url !== '/effect'
        ) {
          outgoing.writeHead(404).end();
          return;
        }
        const supplied = Buffer.from(incoming.headers.authorization ?? '');
        const authorized =
          supplied.length === authorization.length &&
          timingSafeEqual(supplied, authorization);
        supplied.fill(0);
        if (!authorized) {
          outgoing.writeHead(401).end();
          return;
        }
        const bytes: Buffer[] = [];
        let length = 0;
        for await (const raw of incoming) {
          const chunk = Buffer.isBuffer(raw)
            ? raw
            : Buffer.from(raw as Uint8Array);
          length += chunk.length;
          if (length > maximumBytes) {
            outgoing.writeHead(413).end();
            incoming.destroy();
            return;
          }
          bytes.push(chunk);
        }
        const text = Buffer.concat(bytes).toString('utf8');
        const body: unknown = JSON.parse(text);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          outgoing.writeHead(400).end();
          return;
        }
        bodies.push(text); // Test payload only; never retain request headers.
        onEffect();
        await beforeResponse();
        if (responseDisposed()) return;
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ accepted: true, body }));
      } catch {
        if (!outgoing.destroyed) outgoing.writeHead(400).end();
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const dispatch = (
    input: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse> => {
    // No DNS fallback, redirect forwarding or caller-specified local destination.
    if (
      stopped ||
      port === undefined ||
      input.url.href !== controlledActionUrl ||
      input.method !== 'POST' ||
      input.address.address !== publicTestAddress ||
      input.address.family !== 4 ||
      input.body === undefined ||
      input.body.byteLength > maximumBytes ||
      Object.keys(input.headers).some(
        (name) => !['authorization', 'content-type'].includes(name),
      ) ||
      input.timeoutMillis < 1 ||
      input.timeoutMillis > 10_000 ||
      input.signal?.aborted === true
    )
      return Promise.reject(new Error('Owned HTTP dispatch rejected'));
    return new Promise((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let settled = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        response?.destroy();
        outgoing.destroy();
      };
      const fail = () => {
        close();
        if (!settled) {
          settled = true;
          reject(new Error('Owned HTTP exchange failed'));
        }
      };
      const abort = () => {
        fail();
      };
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          path: '/effect',
          method: 'POST',
          headers: {
            ...input.headers,
            'content-length': input.body?.byteLength,
          },
        },
        (incoming) => {
          response = incoming;
          if (closed || input.signal?.aborted === true) {
            fail();
            return;
          }
          settled = true;
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: (async function* () {
              let length = 0;
              try {
                for await (const raw of incoming) {
                  const chunk = Buffer.isBuffer(raw)
                    ? raw
                    : Buffer.from(raw as Uint8Array);
                  length += chunk.byteLength;
                  if (length > maximumBytes)
                    throw new Error('Owned HTTP response exceeds bound');
                  yield chunk;
                }
              } catch {
                throw new Error('Owned HTTP response unavailable');
              } finally {
                close();
              }
            })(),
            close,
          });
        },
      );
      outgoing.on('error', fail);
      const timer = setTimeout(fail, input.timeoutMillis);
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted === true) {
        fail();
        return;
      }
      outgoing.end(input.body);
    });
  };
  const httpClient = new SecureHttpClient(
    {
      resolve: (hostname) =>
        hostname === logicalHost
          ? Promise.resolve([
              { address: publicTestAddress, family: 4 as const },
            ])
          : Promise.reject(new Error('Owned HTTP hostname rejected')),
    },
    { dispatch },
  );
  return {
    httpClient,
    // Export this actual adapter for pre-socket rejection/fault regression tests.
    transport: { dispatch },
    start() {
      if (stopped)
        return Promise.reject(new Error('Owned HTTP server disposed'));
      startup ??= new Promise<void>((resolve, reject) => {
        server.once('error', () => {
          reject(new Error('Owned HTTP server startup failed'));
        });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (stopped || address === null || typeof address === 'string') {
            reject(new Error('Owned HTTP server startup unavailable'));
            return;
          }
          port = address.port;
          resolve();
        });
      });
      return startup;
    },
    observe() {
      return {
        requests,
        effects: bodies.length,
        bodies: [...bodies],
        sockets: sockets.size,
      };
    },
    close() {
      stopped = true;
      closing ??= (async () => {
        await startup?.catch(() => undefined);
        for (const socket of sockets) socket.destroy();
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(new Error('Owned HTTP server shutdown failed'));
            });
          });
        authorization.fill(0);
      })();
      return closing;
    },
  };
}
