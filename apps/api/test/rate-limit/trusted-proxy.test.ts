import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

describe('trusted proxy boundary', () => {
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('ignores forwarded addresses when no ingress proxy is trusted', async () => {
    const server = Fastify({ trustProxy: false });
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

  it('trusts forwarded addresses only when the direct peer is an allowed ingress', async () => {
    const server = Fastify({ trustProxy: ['127.0.0.1'] });
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

    const directResponse = await server.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      remoteAddress: '203.0.113.40',
    });
    expect(directResponse.json()).toEqual({ ip: '203.0.113.40' });
  });

  it('exposes the coerced value after validating a primitive request root', async () => {
    const server = Fastify();
    servers.push(server);
    server.post<{ Body: number }>(
      '/primitive',
      { schema: { body: { type: 'integer', minimum: 1, maximum: 10 } } },
      (request) => ({ type: typeof request.body, value: request.body }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/primitive',
      headers: { 'content-type': 'application/json' },
      payload: '"10"',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ type: 'number', value: 10 });
  });
});
