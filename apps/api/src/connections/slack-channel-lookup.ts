import {
  ConnectionUnavailableError,
  type ResolvedConnectionSecretRecord,
} from '@pertexo/database/api';
import {
  ConnectionSecretEncryptionError,
  SecureHttpError,
} from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/index.js';
import {
  authorizeConnectionOperation,
  reauthorizeConnectionSecretAccess,
} from './authorization.js';
import type {
  ConnectionLookupPersistence,
  ConnectionSecretEncryptionPort,
  ConnectionSlackClient,
} from './ports.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import {
  slackBotTokenCredentialSchema,
  slackChannelLookupQuerySchema,
  slackChannelLookupResponseSchema,
  type SlackChannelLookupItem,
  type SlackChannelLookupResponse,
  type SlackChannelUnresolvedReason,
} from './types.js';
import {
  encryptionSignal,
  type ConnectionCommandInput,
} from './use-case-support.js';

/** ADR 046: per call and for the whole request, both bounded by the caller. */
const LOOKUP_CALL_TIMEOUT_MILLIS = 5_000;
const LOOKUP_BUDGET_MILLIS = 15_000;
const LOOKUP_PURPOSE = 'slack.channel_lookup';
const CREDENTIAL_REJECTED = new Set([
  'account_inactive',
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
]);

type SlackChannelLookupClient = Pick<ConnectionSlackClient, 'lookupChannel'>;
type ChannelOutcome = Readonly<{
  item: SlackChannelLookupItem;
  /** Set when every later channel would fail the same way. */
  stop?: SlackChannelUnresolvedReason;
}>;

export type LookupSlackChannelsQuery = ConnectionCommandInput &
  Readonly<{ connectionId: string; query: unknown }>;

/**
 * Resolves Slack channel IDs to display names with the connection's bot
 * token. Names are display hints only: nothing is stored, connection health
 * never changes, and a channel that cannot be resolved says why instead of
 * failing the request.
 */
export class LookupSlackChannelsUseCase {
  public constructor(
    private readonly persistence: ConnectionLookupPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'open'>,
    private readonly slackClient: SlackChannelLookupClient | undefined,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(
    input: LookupSlackChannelsQuery,
  ): Promise<SlackChannelLookupResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.slackChannelLookup,
      async () => {
        await authorizeConnectionOperation(
          input,
          this.authorization,
          'connection:use',
        );
        const { channelIds } = slackChannelLookupQuerySchema.parse(input.query);
        const named = channelIds.filter(hasChannelName);
        if (named.length === 0) return respond(channelIds, new Map());
        if (this.slackClient === undefined)
          return respond(
            channelIds,
            allUnresolved(named, 'provider_unavailable'),
          );
        const signal = AbortSignal.any([
          encryptionSignal(input),
          AbortSignal.timeout(LOOKUP_BUDGET_MILLIS),
        ]);
        const resolved = await this.resolveSecret(input, signal);
        if (resolved === undefined)
          return respond(
            channelIds,
            allUnresolved(named, 'connection_unavailable'),
          );
        return respond(
          channelIds,
          await this.lookupWithSecret(
            this.slackClient,
            input,
            resolved,
            named,
            signal,
          ),
        );
      },
    );
  }

  private async resolveSecret(
    input: LookupSlackChannelsQuery,
    signal: AbortSignal,
  ): Promise<ResolvedConnectionSecretRecord | undefined> {
    await reauthorizeConnectionSecretAccess(input, this.authorization);
    try {
      return await this.persistence.resolveConnectionLookupSecret({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
        expectedProviderKey: 'slack',
        purpose: LOOKUP_PURPOSE,
        signal,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
    } catch (error: unknown) {
      if (error instanceof ConnectionUnavailableError) return undefined;
      throw error;
    }
  }

  private async lookupWithSecret(
    client: SlackChannelLookupClient,
    input: LookupSlackChannelsQuery,
    resolved: ResolvedConnectionSecretRecord,
    channelIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, SlackChannelLookupItem>> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await this.encryption.open(
        resolved.sealed,
        {
          workspaceId: input.routeWorkspaceId,
          connectionId: input.connectionId,
          secretVersionId: resolved.secretVersionId,
        },
        signal,
      );
      const { botToken } = decodeSlackCredential(plaintext);
      const items = new Map<string, SlackChannelLookupItem>();
      let stopped: SlackChannelUnresolvedReason | undefined;
      for (const channelId of channelIds) {
        const outcome =
          stopped === undefined
            ? await lookupOne(client, botToken, channelId, signal)
            : { item: unresolved(channelId, stopped) };
        items.set(channelId, outcome.item);
        stopped ??= outcome.stop;
      }
      return items;
    } finally {
      plaintext?.fill(0);
    }
  }
}

async function lookupOne(
  client: SlackChannelLookupClient,
  botToken: string,
  channelId: string,
  signal: AbortSignal,
): Promise<ChannelOutcome> {
  let result: Awaited<ReturnType<SlackChannelLookupClient['lookupChannel']>>;
  try {
    result = await client.lookupChannel({
      botToken,
      channelId,
      timeoutMillis: LOOKUP_CALL_TIMEOUT_MILLIS,
      signal,
      beforeDispatch: () => {
        signal.throwIfAborted();
        return Promise.resolve();
      },
    });
  } catch (error: unknown) {
    if (!(error instanceof SecureHttpError)) throw error;
    return stopWith(channelId, 'provider_unavailable');
  }
  switch (result.kind) {
    case 'succeeded':
      return {
        item: { channelId, status: 'resolved', name: result.name },
      };
    case 'rate_limited':
      return stopWith(channelId, 'rate_limited');
    case 'rejected':
      return rejectedOutcome(channelId, result.error);
    case 'http_failure':
    case 'invalid_response':
      return stopWith(channelId, 'provider_unavailable');
  }
}

function rejectedOutcome(channelId: string, error: string): ChannelOutcome {
  if (error === 'channel_not_found')
    return { item: unresolved(channelId, 'not_found') };
  if (error === 'missing_scope') return stopWith(channelId, 'missing_scope');
  return stopWith(
    channelId,
    CREDENTIAL_REJECTED.has(error)
      ? 'connection_unavailable'
      : 'provider_unavailable',
  );
}

function stopWith(
  channelId: string,
  reason: SlackChannelUnresolvedReason,
): ChannelOutcome {
  return { item: unresolved(channelId, reason), stop: reason };
}

function unresolved(
  channelId: string,
  reason: SlackChannelUnresolvedReason,
): SlackChannelLookupItem {
  return { channelId, status: 'unresolved', reason };
}

/** Public (`C…`) and private (`G…`) channels have names; DMs and users don't. */
function hasChannelName(channelId: string): boolean {
  return channelId.startsWith('C') || channelId.startsWith('G');
}

function allUnresolved(
  channelIds: readonly string[],
  reason: SlackChannelUnresolvedReason,
): ReadonlyMap<string, SlackChannelLookupItem> {
  return new Map(
    channelIds.map((channelId) => [channelId, unresolved(channelId, reason)]),
  );
}

function respond(
  channelIds: readonly string[],
  items: ReadonlyMap<string, SlackChannelLookupItem>,
): SlackChannelLookupResponse {
  return slackChannelLookupResponseSchema.parse({
    items: channelIds.map(
      (channelId) =>
        items.get(channelId) ?? unresolved(channelId, 'not_a_channel'),
    ),
  });
}

function decodeSlackCredential(plaintext: Uint8Array) {
  try {
    return slackBotTokenCredentialSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
    );
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}
