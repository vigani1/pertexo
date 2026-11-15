import type { Role } from '@pertexo/policy';
import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '@pertexo/core/testing';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/secrets/server';
import type { SlackChannelLookupResult } from '@pertexo/integrations/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionLookupPersistence,
  ConnectionSlackClient,
} from '../../../src/connections/ports.js';
import { LookupSlackChannelsService } from '../../../src/connections/failure-notifications/slack-channel-lookup.js';
import {
  actor,
  actorId,
  authorization,
  connectionId,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from '../support/use-case-fixture.js';

const botToken = 'xoxb-123456789-secret';

function fixture(
  results: Readonly<Record<string, SlackChannelLookupResult | Error>> = {},
  options: Readonly<{
    persistenceError?: Error;
    plaintext?: unknown;
    withoutSlack?: boolean;
    role?: Role;
  }> = {},
) {
  let plaintext: Uint8Array | undefined;
  const persistence = {
    resolveConnectionLookupSecret: vi.fn<
      ConnectionLookupPersistence['resolveConnectionLookupSecret']
    >(() =>
      options.persistenceError === undefined
        ? Promise.resolve({
            connection: record({
              providerKey: 'slack',
              authType: 'slack_bot_token',
            }),
            secretVersionId,
            sealed,
          })
        : Promise.reject(options.persistenceError),
    ),
  };
  const encryption = {
    open: vi.fn(() => {
      plaintext = new TextEncoder().encode(
        JSON.stringify(
          options.plaintext ?? {
            type: 'slack_bot_token',
            botToken,
          },
        ),
      );
      return Promise.resolve(plaintext);
    }),
  };
  const lookupChannel = vi.fn<ConnectionSlackClient['lookupChannel']>(
    async (input) => {
      await input.beforeDispatch();
      const result = results[input.channelId] ?? {
        kind: 'succeeded' as const,
        channelId: input.channelId,
        name: `name-${input.channelId.toLowerCase()}`,
      };
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const access = authorization();
  if (options.role === 'viewer')
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
  const service = new LookupSlackChannelsService(persistence, access, {
    encryption: encryption,
    slackClient: options.withoutSlack === true ? undefined : { lookupChannel },
  });
  return {
    persistence,
    encryption,
    lookupChannel,
    plaintext: () => plaintext,
    lookup: (
      channelIds: readonly string[],
      signal?: AbortSignal,
      metadata: Readonly<{ requestId?: string; traceId?: string }> = {
        requestId: 'request-lookup',
      },
    ) =>
      service.execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        ...metadata,
        channelIds,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

const unresolved = (channelId: string, reason: string) => ({
  channelId,
  status: 'unresolved',
  reason,
});

describe('Slack channel-name lookup use case (ADR 046)', () => {
  it('resolves channels in request order and never looks up DMs or users', async () => {
    const lookup = fixture({
      C0404: { kind: 'rejected', error: 'channel_not_found' },
    });

    await expect(
      lookup.lookup(['D0001', 'C0123', 'C0404', 'U0002', 'G0456']),
    ).resolves.toEqual({
      items: [
        unresolved('D0001', 'not_a_channel'),
        { channelId: 'C0123', status: 'resolved', name: 'name-c0123' },
        unresolved('C0404', 'not_found'),
        unresolved('U0002', 'not_a_channel'),
        { channelId: 'G0456', status: 'resolved', name: 'name-g0456' },
      ],
    });
    expect(
      lookup.lookupChannel.mock.calls.map(([input]) => input.channelId),
    ).toEqual(['C0123', 'C0404', 'G0456']);
    expect(lookup.lookupChannel.mock.calls[0]?.[0]).toMatchObject({
      botToken,
      timeoutMillis: 5_000,
    });
    expect(
      lookup.persistence.resolveConnectionLookupSecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        connectionId,
        expectedProviderKey: 'slack',
        purpose: 'slack.channel_lookup',
        requestId: 'request-lookup',
      }),
    );
    expect(lookup.encryption.open).toHaveBeenCalledWith(
      sealed,
      { workspaceId, connectionId, secretVersionId },
      expect.any(AbortSignal),
    );
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
  });

  it('forwards only the request metadata the caller has', async () => {
    const lookup = fixture();

    await lookup.lookup(['C0001'], undefined, { traceId: 'trace-lookup' });

    const input =
      lookup.persistence.resolveConnectionLookupSecret.mock.calls[0]?.[0];
    expect(input).toMatchObject({ traceId: 'trace-lookup' });
    expect(input).not.toHaveProperty('requestId');
  });

  it('answers direct messages alone without touching the credential', async () => {
    const lookup = fixture();

    await expect(lookup.lookup(['D0001', 'U0002'])).resolves.toEqual({
      items: [
        unresolved('D0001', 'not_a_channel'),
        unresolved('U0002', 'not_a_channel'),
      ],
    });
    expect(
      lookup.persistence.resolveConnectionLookupSecret,
    ).not.toHaveBeenCalled();
    expect(lookup.encryption.open).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a revoked or reauthorization-required connection',
      { persistenceError: new ConnectionUnavailableError('revoked') },
      'connection_unavailable',
    ],
    ['a missing Slack client', { withoutSlack: true }, 'provider_unavailable'],
  ] as const)(
    'reports %s for every channel without decrypting',
    async (_label, options, reason) => {
      const lookup = fixture({}, options);

      await expect(lookup.lookup(['C0123', 'D0001'])).resolves.toEqual({
        items: [
          unresolved('C0123', reason),
          unresolved('D0001', 'not_a_channel'),
        ],
      });
      expect(lookup.encryption.open).not.toHaveBeenCalled();
      expect(lookup.lookupChannel).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ kind: 'rejected', error: 'missing_scope' }, 'missing_scope'],
    [{ kind: 'rejected', error: 'token_revoked' }, 'connection_unavailable'],
    [{ kind: 'rejected', error: 'fatal_error' }, 'provider_unavailable'],
    [{ kind: 'rate_limited', retryAfterMillis: 1_000 }, 'rate_limited'],
    [{ kind: 'http_failure', status: 502 }, 'provider_unavailable'],
    [{ kind: 'invalid_response' }, 'provider_unavailable'],
    [
      new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', {
        possiblyDispatched: true,
      }),
      'provider_unavailable',
    ],
  ] as const)(
    'stops after %j and gives the remaining channels the same reason',
    async (result, reason) => {
      const lookup = fixture({ C0001: result });

      await expect(lookup.lookup(['C0001', 'C0002', 'G0003'])).resolves.toEqual(
        {
          items: [
            unresolved('C0001', reason),
            unresolved('C0002', reason),
            unresolved('G0003', reason),
          ],
        },
      );
      expect(lookup.lookupChannel).toHaveBeenCalledOnce();
      expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('propagates unexpected failures and still clears the credential', async () => {
    const failure = new Error('unexpected adapter failure');
    const lookup = fixture({ C0001: failure });

    await expect(lookup.lookup(['C0001'])).rejects.toBe(failure);
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);

    const aborted = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.lookup(['C0001'], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a corrupt credential as unavailable protection', async () => {
    const lookup = fixture({}, { plaintext: { type: 'http_headers' } });

    await expect(lookup.lookup(['C0001'])).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect(lookup.lookupChannel).not.toHaveBeenCalled();
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
  });

  it('keeps invisible connections and viewers away from the credential', async () => {
    const hidden = fixture(
      {},
      { persistenceError: new ConnectionNotFoundError('hidden') },
    );
    await expect(hidden.lookup(['C0001'])).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );

    const viewer = fixture({}, { role: 'viewer' });
    await expect(viewer.lookup(['C0001'])).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    expect(
      viewer.persistence.resolveConnectionLookupSecret,
    ).not.toHaveBeenCalled();
  });
});

// ADR 046 bounds the whole lookup at 15 s. Slack answering slowly but
// successfully used to run past it; the next channel's dispatch then threw
// the budget's TimeoutError and the request failed with a 500.
describe('Slack channel lookup past its whole-request budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the answers it got and says the provider is unavailable for the rest', async () => {
    vi.useFakeTimers();
    const lookup = fixture();
    lookup.lookupChannel.mockImplementation(async (input) => {
      await input.beforeDispatch();
      // Every answer arrives, just slowly: 6 s each.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return {
        kind: 'succeeded' as const,
        channelId: input.channelId,
        name: `name-${input.channelId.toLowerCase()}`,
      };
    });

    const answer = lookup.lookup(['C0001', 'C0002', 'C0003', 'C0004', 'G0005']);
    await vi.advanceTimersByTimeAsync(18_000);

    await expect(answer).resolves.toEqual({
      items: [
        { channelId: 'C0001', status: 'resolved', name: 'name-c0001' },
        { channelId: 'C0002', status: 'resolved', name: 'name-c0002' },
        { channelId: 'C0003', status: 'resolved', name: 'name-c0003' },
        unresolved('C0004', 'provider_unavailable'),
        unresolved('G0005', 'provider_unavailable'),
      ],
    });
    expect(lookup.lookupChannel).toHaveBeenCalledTimes(4);
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
  });

  // Review of batch K, P3-2: the budget also covers reading and opening the
  // credential, before any channel is asked.
  it('says the provider is unavailable when the credential stalls past the budget', async () => {
    vi.useFakeTimers();
    const lookup = fixture();
    // Opening the credential never answers; only the lookup's signal ends it.
    lookup.encryption.open.mockImplementation(
      (...args: unknown[]) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          const signal = args[2] as AbortSignal;
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        }),
    );

    const answer = lookup.lookup(['C0001', 'G0002']);
    const settled = answer.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await settled).toEqual({
      items: [
        unresolved('C0001', 'provider_unavailable'),
        unresolved('G0002', 'provider_unavailable'),
      ],
    });
    expect(lookup.lookupChannel).not.toHaveBeenCalled();
  });

  it('still reports the caller giving up as an abort, not as Slack being slow', async () => {
    vi.useFakeTimers();
    const lookup = fixture();
    const controller = new AbortController();
    lookup.lookupChannel.mockImplementation(async (input) => {
      await input.beforeDispatch();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return {
        kind: 'succeeded' as const,
        channelId: input.channelId,
        name: 'name',
      };
    });

    const answer = lookup.lookup(['C0001', 'C0002'], controller.signal);
    const settled = answer.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(await settled).toMatchObject({ name: 'AbortError' });
  });
});
