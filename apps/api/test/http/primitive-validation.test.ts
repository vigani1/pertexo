import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('HTTP primitive validation', () => {
  it('exposes the coerced value after validating a primitive request root', async () => {
    const server = Fastify();
    try {
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
    } finally {
      await server.close();
    }
  });
});
