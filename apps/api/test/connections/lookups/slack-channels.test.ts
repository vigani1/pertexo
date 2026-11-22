import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '@pertexo/core/testing';
import {
  ProviderHttpError,
  type ProviderHttpClient,
} from '@pertexo/integrations/server';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LookupConnectionOptionsService } from '../../../src/connections/lookups/lookup-options.service.js';
import {
  actor,
  connectionId,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from '../support/use-case-fixture.js';

const botToken = 'xoxb-123456789-secret';

function fixture() {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      type: 'slack_bot_token',
      botToken,
    }),
  );
  const persistence = {
    resolveConnectionLookupSecret: vi.fn(async () => ({
      connection: record({ providerKey: 'slack', authType: 'slack_bot_token' }),
      secretVersionId,
      sealed,
    })),
    assertConnectionLookupSecretCurrent: vi.fn(async () => undefined),
  };
  const encryption = {
    open: vi.fn<
      ConstructorParameters<
        typeof LookupConnectionOptionsService
      >[0]['encryption']['open']
    >(async () => plaintext),
  };
  const channelIds: string[] = [];
  const reply = vi.fn<(id: string, signal: AbortSignal) => Promise<unknown>>(
    async (id) =>
      id === 'C0404'
        ? { ok: false, error: 'channel_not_found' }
        : { ok: true, channel: { id, name: `name-${id.toLowerCase()}` } },
  );
  const execute = vi.fn<ProviderHttpClient['execute']>(async (request) => {
    await request.beforeDispatch();
    const id =
      new URLSearchParams(
        new TextDecoder().decode(request.body as Uint8Array),
      ).get('channel') ?? '';
    channelIds.push(id);
    return {
      status: 200,
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify(await reply(id, request.signal!)),
      ),
      bodyEncoding: 'utf8',
      finalUrl: request.url,
      redirectCount: 0,
    };
  });
  const service = new LookupConnectionOptionsService({
    persistence,
    encryption,
    http: { execute, executeStreaming: vi.fn() },
  });
  return {
    lookup: (ids: readonly string[], signal?: AbortSignal) =>
      service.execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        requestId: 'request-lookup',
        request: {
          providerKey: 'slack',
          lookup: 'channels',
          input: { channelIds: ids },
        },
        ...(signal === undefined ? {} : { signal }),
      }),
    channelIds,
    execute,
    reply,
    encryption,
    persistence,
    plaintext,
  };
}

const resolved = (value: string) => ({
  value,
  label: `name-${value.toLowerCase()}`,
});
const unresolved = (value: string, unavailableReason: string) => ({
  value,
  label: value,
  unavailableReason,
});

describe('Slack channels through connection lookups', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves in order, continues after a missing channel, and skips DMs and users', async () => {
    const f = fixture();
    await expect(
      f.lookup(['D0001', 'C0123', 'C0404', 'U0002', 'G0456']),
    ).resolves.toEqual({
      items: [
        unresolved('D0001', 'not_a_channel'),
        resolved('C0123'),
        unresolved('C0404', 'not_found'),
        unresolved('U0002', 'not_a_channel'),
        resolved('G0456'),
      ],
    });
    expect(f.channelIds).toEqual(['C0123', 'C0404', 'G0456']);
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://slack.com/api/conversations.info',
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}` },
      timeoutMillis: 5_000,
      maxRedirects: 0,
      maxResponseBytes: 65_536,
    });
    expect(f.persistence.resolveConnectionLookupSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId: actor.actorId,
        connectionId,
        expectedProviderKey: 'slack',
        purpose: 'slack.channels.lookup',
        requestId: 'request-lookup',
      }),
    );
    expect(
      f.persistence.assertConnectionLookupSecretCurrent,
    ).toHaveBeenCalledTimes(3);
    expect(f.encryption.open).toHaveBeenCalledWith(
      sealed,
      { workspaceId, connectionId, secretVersionId },
      expect.any(AbortSignal),
    );
    expect(f.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('answers DMs and users without opening a credential', async () => {
    const f = fixture();
    await expect(f.lookup(['D0001', 'U0002'])).resolves.toEqual({
      items: [
        unresolved('D0001', 'not_a_channel'),
        unresolved('U0002', 'not_a_channel'),
      ],
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.encryption.open).not.toHaveBeenCalled();
  });

  it.each([
    ['missing_scope', 'missing_scope'],
    ['token_revoked', 'connection_unavailable'],
    ['invalid_auth', 'connection_unavailable'],
    ['ratelimited', 'rate_limited'],
    ['fatal_error', 'provider_unavailable'],
  ])(
    'stops provider calls after %s and gives the remaining IDs the same reason',
    async (error, reason) => {
      const f = fixture();
      f.reply.mockResolvedValue({ ok: false, error });
      await expect(f.lookup(['C0001', 'G0002', 'D0003'])).resolves.toEqual({
        items: [
          unresolved('C0001', reason),
          unresolved('G0002', reason),
          unresolved('D0003', 'not_a_channel'),
        ],
      });
      expect(f.channelIds).toEqual(['C0001']);
      expect(f.plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('reports a transport timeout without dispatching any later lookup', async () => {
    const f = fixture();
    f.reply.mockRejectedValue(
      new ProviderHttpError('timed_out', 'ambiguous', {
        possiblyDispatched: true,
      }),
    );
    await expect(f.lookup(['C0001', 'G0002'])).resolves.toEqual({
      items: [
        unresolved('C0001', 'provider_unavailable'),
        unresolved('G0002', 'provider_unavailable'),
      ],
    });
    expect(f.channelIds).toEqual(['C0001']);
  });

  it('returns unavailable for a revoked connection and keeps hidden connections non-disclosing', async () => {
    const f = fixture();
    f.persistence.resolveConnectionLookupSecret.mockRejectedValueOnce(
      new ConnectionUnavailableError('revoked'),
    );
    await expect(f.lookup(['C0001', 'D0002'])).resolves.toEqual({
      items: [
        unresolved('C0001', 'connection_unavailable'),
        unresolved('D0002', 'not_a_channel'),
      ],
    });
    f.persistence.resolveConnectionLookupSecret.mockRejectedValueOnce(
      new ConnectionNotFoundError('hidden'),
    );
    await expect(f.lookup(['C0001'])).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    expect(f.encryption.open).not.toHaveBeenCalled();
  });

  it('refuses a corrupt credential and clears its plaintext', async () => {
    const f = fixture();
    f.plaintext.fill(1);
    await expect(f.lookup(['C0001'])).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([{ ids: ['C0001', 'C0001'] }, { ids: ['c0001'] }, { ids: [] }])(
    'rejects invalid channel IDs $ids before secret access',
    async ({ ids }) => {
      const f = fixture();
      await expect(f.lookup(ids)).rejects.toMatchObject({
        issues: [{ path: ['input'] }],
      });
      expect(f.encryption.open).not.toHaveBeenCalled();
    },
  );

  it('preserves results read before the 15-second deadline and stops further requests', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reply.mockImplementation(
      (id, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                ok: true,
                channel: { id, name: `name-${id.toLowerCase()}` },
              }),
            4_000,
          );
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const answer = f.lookup(['C0001', 'C0002', 'C0003', 'C0004', 'G0005']);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(answer).resolves.toEqual({
      items: [
        resolved('C0001'),
        resolved('C0002'),
        resolved('C0003'),
        unresolved('C0004', 'provider_unavailable'),
        unresolved('G0005', 'provider_unavailable'),
      ],
    });
    expect(f.channelIds).toEqual(['C0001', 'C0002', 'C0003', 'C0004']);
    expect(f.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('includes credential opening in the deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.encryption.open.mockImplementation(
      (_sealed, _context, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const answer = f.lookup(['G0001']);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(answer).resolves.toEqual({
      items: [unresolved('G0001', 'provider_unavailable')],
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('propagates a caller abort while a provider request is in flight', async () => {
    const f = fixture();
    const caller = new AbortController();
    f.reply.mockImplementation(async (_id, signal) => {
      caller.abort();
      signal.throwIfAborted();
    });
    await expect(
      f.lookup(['C0001', 'C0002'], caller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.channelIds).toEqual(['C0001']);
  });
});
