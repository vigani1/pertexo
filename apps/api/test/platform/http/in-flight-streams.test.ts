import { request } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerInFlightLimit } from '../../../src/platform/http/in-flight-limit.js';
import { prepareSseResponse } from '../../../src/platform/http/sse-response.js';

const LIMIT = 2;

describe('event streams under the in-flight request bound', () => {
  let fastify: FastifyInstance | undefined;
  const open: (() => void)[] = [];

  afterEach(async () => {
    for (const close of open.splice(0)) close();
    await fastify?.close();
    fastify = undefined;
  });

  async function start(): Promise<string> {
    fastify = Fastify();
    registerInFlightLimit(fastify, {
      limit: LIMIT,
      logger: { warn: () => undefined },
    });
    // A stream stays open for as long as a tab watches; it never ends itself.
    fastify.get('/stream', (_request, reply) => {
      prepareSseResponse(reply);
      reply.raw.write(': open\n\n');
    });
    fastify.get('/ping', () => ({ ok: true }));
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const address = fastify.server.address() as { port: number };
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** Resolves once the stream's first bytes arrive, so it is fully open. */
  function openStream(origin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const outgoing = request(`${origin}/stream`, (response) => {
        response.once('data', () => {
          resolve();
        });
      });
      outgoing.on('error', reject);
      open.push(() => outgoing.destroy());
      outgoing.end();
    });
  }

  it('keeps answering other requests while more streams are open than the bound', async () => {
    const origin = await start();
    for (let index = 0; index < LIMIT * 3; index++) await openStream(origin);

    const response = await fetch(`${origin}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
