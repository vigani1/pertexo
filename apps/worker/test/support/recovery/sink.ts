import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SinkCall = Readonly<{
  at: number;
  body: string;
  method: string;
  path: string;
}>;

/**
 * The outside provider: records every request it receives, because "no
 * duplicate side effect" can only be seen from the provider's side.
 *
 * - `/ok/<id>` answers at once.
 * - `/fail/<id>` answers 500 at once.
 * - `/hold/<seconds>/<id>` answers after that many seconds.
 * - `/hold-first/<id>` never answers its first call, and answers later calls at
 *   once, so a retried step can finish while the first attempt's socket hangs.
 * - `/api/<method>` is Slack, reached through the provider stand-in. A bot token
 *   containing "revoked" is refused the way Slack refuses a revoked one.
 */
export type Sink = Readonly<{
  calls: (id: string) => readonly SinkCall[];
  close: () => Promise<void>;
  origin: string;
  waitForCalls: (id: string, count: number, limitMs: number) => Promise<void>;
}>;

const POLL_MS = 100;

export async function startSink(): Promise<Sink> {
  const calls: SinkCall[] = [];
  const held = new Set<ServerResponse>();
  const firstCallSeen = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();

  const answer = (response: ServerResponse): void => {
    held.delete(response);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  };

  const answerSlack = (
    response: ServerResponse,
    authorization: string | undefined,
  ): void => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        authorization?.includes('revoked') === true
          ? { ok: false, error: 'token_revoked' }
          : { ok: true, channel: 'C123ABC', ts: '1710000000.000001' },
      ),
    );
  };

  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const path = request.url ?? '/';
      calls.push({
        at: Date.now(),
        body,
        method: request.method ?? 'GET',
        path,
      });
      const [, route, first, second] = path.split('/');
      response.on('close', () => held.delete(response));
      if (route === 'api') {
        answerSlack(response, request.headers.authorization);
        return;
      }
      if (route === 'fail') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"ok":false}');
        return;
      }
      if (route === 'hold' && second !== undefined) {
        held.add(response);
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            answer(response);
          },
          Number(first) * 1_000,
        );
        timers.add(timer);
        return;
      }
      if (route === 'hold-first' && first !== undefined) {
        if (!firstCallSeen.has(first)) {
          firstCallSeen.add(first);
          held.add(response);
          return;
        }
      }
      answer(response);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  const callsFor = (id: string): readonly SinkCall[] =>
    calls.filter(({ path }) => path.endsWith(`/${id}`));

  return Object.freeze({
    calls: callsFor,
    origin: `http://127.0.0.1:${String(port)}`,
    async waitForCalls(id, count, limitMs) {
      const deadline = Date.now() + limitMs;
      while (callsFor(id).length < count) {
        if (Date.now() > deadline)
          throw new Error(
            `Provider saw ${String(callsFor(id).length)} of ${String(count)} calls for ${id}`,
          );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  });
}
