import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue/server';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';

// No receive-deadline construction option is exposed by the assembled API.
const beyondReceiveDeadline = 32_000;

describe.runIf(betterAuthIntegrationEnabled)(
  'responses outlasting request receipt',
  () => {
    const api = useBetterAuthRealApi('receive_streams', {
      notifications: true,
    });
    let address: string;
    let browser: Browser;
    let workspaceId: string;
    beforeAll(async () => {
      const server: FastifyInstance = api
        .application()
        .getHttpAdapter()
        .getInstance();
      // A deterministic streaming payload exercises the assembled listener's response policy.
      server.get('/receive-deadline-stream', (_request, reply) =>
        reply.type('text/plain').send(
          Readable.from(
            (async function* () {
              yield 'started\n';
              await delay(beyondReceiveDeadline);
              yield 'completed\n';
            })(),
          ),
        ),
      );
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Receive deadline', slug: `receive-${randomUUID()}` },
      });
      expect(created.statusCode, created.payload).toBe(201);
      workspaceId = created.json<{ id: string }>().id;
      address = await api.listen();
    });

    it('slow: completes a streamed response beyond the receive deadline', async () => {
      const response = await fetch(`${address}/receive-deadline-stream`, {
        signal: AbortSignal.timeout(38_000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('started\ncompleted\n');
    }, 40_000);

    it('slow: keeps SSE open and delivers another event beyond the receive deadline', async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 38_000);
      const publisher = new RedisWorkspaceInboxHintPublisher({
        redisUrl: process.env.REDIS_URL ?? '',
      });
      try {
        const response = await fetch(
          `${address}/v1/workspaces/${workspaceId}/notifications/events`,
          {
            headers: { cookie: browser.cookie },
            signal: controller.signal,
          },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('SSE response has no body');
        const decoder = new TextDecoder();
        let received = '';
        async function readUntil(text: string) {
          while (!received.includes(text)) {
            const chunk = await reader?.read();
            if (chunk === undefined || chunk.done)
              throw new Error('SSE ended before the post-deadline event');
            received += decoder.decode(chunk.value, { stream: true });
          }
        }
        await readUntil('event: inbox.ready');
        await delay(beyondReceiveDeadline);
        await publisher.publish({
          workspaceId,
          revision: '987654',
        });
        await readUntil('data: {"revision":"987654"}');
        expect(received).toContain('event: inbox.changed');
      } finally {
        clearTimeout(timer);
        controller.abort();
        await publisher.close();
      }
    }, 40_000);
  },
);
