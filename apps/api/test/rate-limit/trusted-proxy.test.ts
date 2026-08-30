import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

describe('trusted proxy boundary', () => {
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('ignores forwarded addresses when no ingress proxy is trusted', async () => {
    const server = Fastify({ trustProxy: 0 });
    servers.push(server);
    server.get('/ip', (request) => ({ ip: request.ip }));

    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      remoteAddress: '127.0.0.1',
    });

    expect(response.json()).toEqual({ ip: '127.0.0.1' });
  });

  it('trusts only the nearest forwarded hop behind the configured ingress', async () => {
    const server = Fastify({ trustProxy: 1 });
    servers.push(server);
    server.get('/ip', (request) => ({ ip: request.ip }));

    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      headers: {
        // The leftmost address is attacker-controlled; one trusted hop means
        // the nearest forwarded address is authoritative.
        'x-forwarded-for': '198.51.100.10, 192.0.2.20',
      },
      remoteAddress: '127.0.0.1',
    });

    expect(response.json()).toEqual({ ip: '192.0.2.20' });
  });
});
