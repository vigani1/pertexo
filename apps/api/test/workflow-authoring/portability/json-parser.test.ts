import { FastifyAdapter } from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';
import { registerWorkflowPortabilityJsonParser } from '../../../src/workflow-authoring/portability/json-parser.js';

const url = '/v1/workspaces/workspace/workflows/import/preview';
describe('route-local portability raw JSON boundary', () => {
  it('keeps unregistered POST routes in ordinary parsing without portability response headers', async () => {
    const adapter = new FastifyAdapter();
    registerWorkflowPortabilityJsonParser(adapter);
    try {
      const response = await adapter.getInstance().inject({
        method: 'POST',
        url: '/unregistered',
        headers: { 'content-type': 'application/json' },
        payload: '{"value":1,"value":2}',
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
  it('rejects raw duplicate keys, deep bodies and prototype keys before the handler without reflecting values', async () => {
    const adapter = new FastifyAdapter();
    registerWorkflowPortabilityJsonParser(adapter);
    const server = adapter.getInstance();
    let calls = 0;
    server.post(url, () => {
      calls += 1;
      return {};
    });
    try {
      for (const payload of [
        '{"manifest":{},"manifest":{"secret":"sensitive-value"}}',
        '{"__proto__":{"secret":"sensitive-value"}}',
        '['.repeat(257) + '0' + ']'.repeat(257),
      ]) {
        const response = await server.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.payload).not.toContain('sensitive-value');
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
      expect(calls).toBe(0);
    } finally {
      await adapter.close();
    }
  });
  it('permits 2 MiB only on import routes and preserves ordinary secure parser and 1 MiB limit', async () => {
    const adapter = new FastifyAdapter();
    registerWorkflowPortabilityJsonParser(adapter);
    const server = adapter.getInstance();
    server.post(url, () => ({}));
    server.post('/ordinary', () => ({}));
    try {
      const payload = JSON.stringify({ value: 'a'.repeat(1_048_576) });
      expect(
        (
          await server.inject({
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/ordinary',
            headers: { 'content-type': 'application/json' },
            payload,
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await server.inject({
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({ value: 'a'.repeat(2_097_152) }),
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/ordinary',
            headers: { 'content-type': 'application/json' },
            payload: '{"__proto__":{}}',
          })
        ).statusCode,
      ).toBe(400);
      const ordinary = await server.inject({
        method: 'POST',
        url: '/ordinary',
        headers: { 'content-type': 'application/json' },
        payload: '{"value":1,"value":2}',
      });
      expect(ordinary.statusCode).toBe(200);
    } finally {
      await adapter.close();
    }
  });
});
