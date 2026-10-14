import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationHttpClient } from '../src/http.js';
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential = `ptx_1.${workspace}.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.${'A'.repeat(43)}`;
const input = {
  path: '/v1/workspaces/test' as const,
  signal: new AbortController().signal,
  effect: 'read' as const,
};
const config = { origin: 'http://127.0.0.1:3000', credential };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':
        status === 200 ? 'application/json' : 'application/problem+json',
    },
  });
}
describe('automation HTTP', () => {
  it('sends only bearer authority and preserves original key/etag/body', async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ items: [], nextCursor: null }));
    await createAutomationHttpClient(config, fetchRequest).request({
      ...input,
      effect: 'write',
      method: 'POST',
      headers: { 'Idempotency-Key': 'original', 'If-Match': '"opaque"' },
      body: { input: 1 },
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      `${config.origin}${input.path}`,
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        method: 'POST',
        body: '{"input":1}',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Idempotency-Key': 'original',
          'If-Match': '"opaque"',
          Accept: 'application/json, application/problem+json',
          'Content-Type': 'application/json',
        },
      }),
    );
  });
  it.each(['read', 'write'] as const)(
    'handles malformed responses and lost transport for a %s operation',
    async (effect) => {
      for (const result of [
        new Response('{', { headers: { 'Content-Type': 'application/json' } }),
        new Response('html'),
        response({ secret: credential }),
        response({ secret: 'A'.repeat(43) }),
        response({ invalid: true }, 403),
      ]) {
        await expect(
          createAutomationHttpClient(
            config,
            vi.fn<typeof fetch>().mockResolvedValue(result),
          ).request({ ...input, effect, method: 'POST' }),
        ).rejects.toMatchObject({
          code: 'cli.invalid_response',
          uncertain: effect === 'write',
        });
      }
      await expect(
        createAutomationHttpClient(
          config,
          vi.fn<typeof fetch>().mockRejectedValue(new Error(credential)),
        ).request({ ...input, effect }),
      ).rejects.toMatchObject({
        code: 'cli.transport_failure',
        uncertain: effect === 'write',
        message: 'The API could not be reached, or refused a redirect.',
      });
    },
  );
  it('accepts safe common problem fields with endpoint-specific extensions', async () => {
    const result = response(
      {
        type: 'about:blank',
        title: 'Conflict',
        status: 412,
        code: 'workflow.revision_conflict',
        detail: 'Review the draft again.',
        requestId: 'request-123',
        currentRevision: 2,
        currentEtag: '"opaque"',
      },
      412,
    );
    await expect(
      createAutomationHttpClient(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(result),
      ).request({ ...input, effect: 'write', method: 'POST' }),
    ).rejects.toMatchObject({
      code: 'workflow.revision_conflict',
      requestId: 'request-123',
      uncertain: false,
      message: 'Review the draft again.',
    });
  });
  it('refuses credential material in response metadata as well as JSON', async () => {
    const result = response({ items: [], nextCursor: null });
    result.headers.set('etag', `"draft.${'A'.repeat(43)}"`);
    await expect(
      createAutomationHttpClient(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(result),
      ).request(input),
    ).rejects.toMatchObject({
      code: 'cli.invalid_response',
      message: 'The server response contains credential material.',
    });
  });
  it('bounds streamed response size and cancels the reader', async () => {
    let canceled = false;
    const result = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    await expect(
      createAutomationHttpClient(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(result),
      ).request(input),
    ).rejects.toMatchObject({ code: 'cli.invalid_response', uncertain: false });
    expect(canceled).toBe(true);
  });
  it('refuses oversized requests before sending anything', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    await expect(
      createAutomationHttpClient(config, fetchRequest).request({
        ...input,
        effect: 'write',
        body: 'x'.repeat(2 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: 'cli.invalid_file', uncertain: false });
    expect(fetchRequest).not.toHaveBeenCalled();
  });
  it('interrupts in-flight work without leaking errors', async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    await expect(
      createAutomationHttpClient(
        config,
        vi.fn<typeof fetch>().mockRejectedValue(new Error(credential)),
      ).request({ ...input, signal: shutdown.signal, effect: 'write' }),
    ).rejects.toMatchObject({
      code: 'cli.transport_failure',
      message: 'Command interrupted.',
      uncertain: true,
    });
  });
  it('enforces its request deadline for a stalled body without exposing transport causes', async () => {
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockImplementation((_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => {
                    controller.error(new Error(credential));
                  },
                  { once: true },
                );
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
    const pending = createAutomationHttpClient(config, fetchRequest).request({
      ...input,
      effect: 'write',
      method: 'POST',
    });
    await Promise.resolve();
    deadline.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'cli.transport_failure',
      message: 'The API request timed out.',
      uncertain: true,
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
  it('never follows a real redirect or forwards authorization to its destination', async () => {
    let destination = 0;
    let sourceAuthorization: string | undefined;
    const server = createServer((request, res) => {
      if (request.url === '/v1/destination') {
        destination++;
        res.end('{}');
        return;
      }
      sourceAuthorization = request.headers.authorization;
      res.writeHead(302, { Location: '/v1/destination' });
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('missing bound server');
      await expect(
        createAutomationHttpClient({
          origin: `http://127.0.0.1:${String(address.port)}`,
          credential,
        }).request(input),
      ).rejects.toMatchObject({ code: 'cli.transport_failure' });
      expect(sourceAuthorization).toBe(`Bearer ${credential}`);
      expect(destination).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
