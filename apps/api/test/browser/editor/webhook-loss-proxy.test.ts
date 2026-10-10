import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorWebhookLossProxy } from './webhook-loss-proxy.js';
import { sendBoundedWebhook } from '../../webhooks/bounded-webhook-client.js';

describe('one owned post-acceptance loss proxy', () => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0).reverse()) await close();
  });
  const endpoint = 'e'.repeat(43),
    secret = 's'.repeat(43),
    runId = randomUUID();
  async function setup(
    assertCommitted: (id: string) => Promise<void>,
    replyStatus = 202,
  ) {
    const calls: { body: string; key: string | undefined }[] = [];
    const server = createServer((incoming, outgoing) => {
      let body = '';
      incoming.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      incoming.on('end', () => {
        calls.push({
          body,
          key:
            typeof incoming.headers['idempotency-key'] === 'string'
              ? incoming.headers['idempotency-key']
              : undefined,
        });
        outgoing
          .writeHead(replyStatus, { 'content-type': 'application/json' })
          .end(JSON.stringify({ runId, replayed: calls.length > 1 }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    closes.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server unavailable');
    const proxy = createEditorWebhookLossProxy(
      `http://127.0.0.1:${String(address.port)}`,
      endpoint,
      assertCommitted,
    );
    closes.push(() => proxy.close());
    await proxy.start();
    return { proxy, calls };
  }
  it('drops only a real 202 after the commit barrier and preserves exact retry bytes/key', async () => {
    const commit = Promise.withResolvers<undefined>();
    const checked = vi.fn(() => commit.promise);
    const { proxy, calls } = await setup(checked);
    const input = {
      endpointKey: endpoint,
      secret,
      rawBody: Buffer.from('{ "marker":"true-branch" }'),
      idempotencyKey: 'exact-sender-key',
      origin: proxy.origin(),
    };
    const first = sendBoundedWebhook(input);
    const rejection = expect(first).rejects.toThrow();
    await expect.poll(() => checked.mock.calls.length).toBe(1);
    expect(proxy.observe().lostRunId).toBeUndefined();
    commit.resolve(undefined);
    await rejection;
    expect(checked.mock.calls[0]).toEqual([runId]);
    expect(proxy.observe().lostRunId).toBe(runId);
    const retry = await sendBoundedWebhook({
      ...input,
      now: () => Date.now() + 1_000,
    });
    expect(retry).toMatchObject({
      status: 202,
      json: { runId, replayed: true },
    });
    expect(calls).toEqual([
      { body: input.rawBody.toString(), key: input.idempotencyKey },
      { body: input.rawBody.toString(), key: input.idempotencyKey },
    ]);
  });
  it('does not call the commit probe or force response loss for denied upstream responses', async () => {
    const checked = vi.fn().mockResolvedValue(undefined);
    const { proxy } = await setup(checked, 401);
    const response = await sendBoundedWebhook({
      endpointKey: endpoint,
      secret,
      rawBody: Buffer.from('{}'),
      idempotencyKey: 'denied',
      origin: proxy.origin(),
    });
    expect(response.status).toBe(401);
    expect(checked).not.toHaveBeenCalled();
    expect(proxy.observe().lostRunId).toBeUndefined();
  });
  it('rejects another endpoint without forwarding a request', async () => {
    const { proxy, calls } = await setup(() => Promise.resolve());
    const response = await sendBoundedWebhook({
      endpointKey: 'b'.repeat(43),
      secret,
      rawBody: Buffer.from('{}'),
      idempotencyKey: 'wrong-target',
      origin: proxy.origin(),
    });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it('disposal during commit observation does not resume forwarding or report a loss success', async () => {
    const barrier = Promise.withResolvers<undefined>();
    const entered = vi.fn(() => barrier.promise);
    const { proxy } = await setup(entered);
    const pending = sendBoundedWebhook({
      endpointKey: endpoint,
      secret,
      rawBody: Buffer.from('{}'),
      idempotencyKey: 'disposed',
      origin: proxy.origin(),
    });
    const failure = expect(pending).rejects.toThrow();
    await expect.poll(() => entered.mock.calls.length).toBe(1);
    await proxy.close();
    barrier.resolve(undefined);
    await failure;
    expect(proxy.observe().lostRunId).toBeUndefined();
    await expect(proxy.start()).rejects.toThrow('Owned webhook proxy disposed');
  });
  it('refuses non-owned origins without producing credential-bearing errors', () => {
    for (const origin of [
      'https://127.0.0.1:8080',
      'http://remote.test:8080',
      'http://127.0.0.1:8080/other',
    ]) {
      expect(() =>
        createEditorWebhookLossProxy(origin, endpoint, () => Promise.resolve()),
      ).toThrow('Owned webhook proxy configuration invalid');
    }
  });
});
