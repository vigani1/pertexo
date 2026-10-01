import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createConnectionHealthSlackTransport } from '../../../../infrastructure/testing/connection-health-slack-transport.mjs';

describe('owned connection health Slack transport', () => {
  it.each(['https://127.0.0.1:1', 'http://localhost:1', 'https://slack.com'])(
    'rejects non-owned origin %s',
    (origin) => {
      expect(() => createConnectionHealthSlackTransport(origin)).toThrow(
        'owned loopback',
      );
    },
  );
  it.each([
    {
      url: 'https://evil.example/api/chat.postMessage',
      authorization: 'Bearer xoxb-owned-fixture-token-1',
    },
    {
      url: 'https://slack.com/api/files.upload',
      authorization: 'Bearer xoxb-owned-fixture-token-1',
    },
    {
      url: 'https://slack.com/api/chat.postMessage',
      authorization: 'Bearer unexpected',
    },
  ])(
    'fails closed before dispatch for $url',
    async ({ url, authorization }) => {
      const beforeDispatch = vi.fn(() => Promise.resolve());
      await expect(
        createConnectionHealthSlackTransport('http://127.0.0.1:1').execute({
          url,
          timeoutMillis: 1000,
          headers: { authorization },
          beforeDispatch,
        }),
      ).rejects.toThrow();
      expect(beforeDispatch).not.toHaveBeenCalled();
    },
  );
  it('preserves dispatch validation and parsed-response input without forwarding credentials', async () => {
    let forwarded: string | undefined;
    const server = createServer((request, response) => {
      forwarded = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, error: 'token_revoked' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Owned transport address absent');
      const beforeDispatch = vi.fn(() => Promise.resolve());
      const url = 'https://slack.com/api/chat.postMessage';
      const result = await createConnectionHealthSlackTransport(
        `http://127.0.0.1:${String(address.port)}`,
      ).execute({
        url,
        timeoutMillis: 1000,
        headers: { authorization: 'Bearer xoxb-owned-fixture-token-1' },
        beforeDispatch,
      });
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(forwarded).toBeUndefined();
      expect(result.finalUrl).toBe(url);
      expect(result.redirectCount).toBe(0);
      expect(JSON.parse(Buffer.from(result.body).toString())).toEqual({
        ok: false,
        error: 'token_revoked',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
