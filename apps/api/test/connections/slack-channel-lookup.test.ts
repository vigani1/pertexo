import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '@pertexo/database/testing';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SlackChannelLookupResult,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectionLookupPersistence,
  ConnectionSlackClient,
} from '../../src/connections/ports.js';
import { LookupSlackChannelsUseCase } from '../../src/connections/use-cases.js';
import {
  actor,
  actorId,
  authorization,
  connectionId,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from './support/use-case-fixture.js';

const botToken = 'xoxb-123456789-secret';

function fixture(
  results: Readonly<Record<string, SlackChannelLookupResult | Error>> = {},
  options: Readonly<{
    persistenceError?: Error;
    plaintext?: unknown;
    withoutSlack?: boolean;
    role?: 'owner' | 'viewer';
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
            schemaVersion: 1,
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
  const useCase = new LookupSlackChannelsUseCase(
    persistence,
    access,
    encryption,
    options.withoutSlack === true ? undefined : { lookupChannel },
  );
  return {
    persistence,
    encryption,
    lookupChannel,
    plaintext: () => plaintext,
    lookup: (
      channelIds: string,
      signal?: AbortSignal,
      metadata: Readonly<{ requestId?: string; traceId?: string }> = {
        requestId: 'request-lookup',
      },
    ) =>
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        ...metadata,
        query: { channelIds },
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
      lookup.lookup('D0001,C0123,C0404,U0002,G0456'),
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

    await lookup.lookup('C0001', undefined, { traceId: 'trace-lookup' });

    const input =
      lookup.persistence.resolveConnectionLookupSecret.mock.calls[0]?.[0];
    expect(input).toMatchObject({ traceId: 'trace-lookup' });
    expect(input).not.toHaveProperty('requestId');
  });

  it('answers direct messages alone without touching the credential', async () => {
    const lookup = fixture();

    await expect(lookup.lookup('D0001,U0002')).resolves.toEqual({
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

      await expect(lookup.lookup('C0123,D0001')).resolves.toEqual({
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
      new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', true),
      'provider_unavailable',
    ],
  ] as const)(
    'stops after %j and gives the remaining channels the same reason',
    async (result, reason) => {
      const lookup = fixture({ C0001: result });

      await expect(lookup.lookup('C0001,C0002,G0003')).resolves.toEqual({
        items: [
          unresolved('C0001', reason),
          unresolved('C0002', reason),
          unresolved('G0003', reason),
        ],
      });
      expect(lookup.lookupChannel).toHaveBeenCalledOnce();
      expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('propagates unexpected failures and still clears the credential', async () => {
    const failure = new Error('unexpected adapter failure');
    const lookup = fixture({ C0001: failure });

    await expect(lookup.lookup('C0001')).rejects.toBe(failure);
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);

    const aborted = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.lookup('C0001', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a corrupt credential as unavailable protection', async () => {
    const lookup = fixture({}, { plaintext: { type: 'http_headers' } });

    await expect(lookup.lookup('C0001')).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect(lookup.lookupChannel).not.toHaveBeenCalled();
    expect(lookup.plaintext()?.every((byte) => byte === 0)).toBe(true);
  });

  it('keeps invisible connections, invalid queries and viewers away from the credential', async () => {
    const hidden = fixture(
      {},
      { persistenceError: new ConnectionNotFoundError('hidden') },
    );
    await expect(hidden.lookup('C0001')).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );

    const invalid = fixture();
    await expect(invalid.lookup('C0001,C0001')).rejects.toMatchObject({
      name: 'ZodError',
    });
    expect(
      invalid.persistence.resolveConnectionLookupSecret,
    ).not.toHaveBeenCalled();

    const viewer = fixture({}, { role: 'viewer' });
    await expect(viewer.lookup('C0001')).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    expect(
      viewer.persistence.resolveConnectionLookupSecret,
    ).not.toHaveBeenCalled();
  });
});
