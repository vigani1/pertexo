import {
  SLACK_CHANNELS_LOOKUP,
  slackChannelLookupInputSchema,
  type SlackChannelUnresolvedReason,
} from '@pertexo/contracts';
import { defineConnectionLookup } from '../providers/connection-lookup.js';
import { ProviderHttpError } from '../providers/http.errors.js';
import { createSlackClient, type SlackClient } from './client.js';
import { SLACK_BOT_TOKEN_CONNECTION } from './connections.definition.js';
import { slackRejection } from './rejection-policy.js';

const CHANNEL_LOOKUP_CALL_TIMEOUT_MILLIS = 5_000;

export const channelsLookup = defineConnectionLookup({
  key: SLACK_CHANNELS_LOOKUP,
  authType: SLACK_BOT_TOKEN_CONNECTION.authType,
  inputSchema: slackChannelLookupInputSchema,
  credentialSchema: SLACK_BOT_TOKEN_CONNECTION.schema,
  local({ channelIds }) {
    if (!channelIds.some(hasChannelName))
      return {
        items: channelIds.map((id) => unavailable(id, 'not_a_channel')),
      };
    return undefined;
  },
  recover({ channelIds }, reason) {
    return { items: channelIds.map((id) => unavailable(id, reason)) };
  },
  async discover({ channelIds }, { botToken }, { http, signal }) {
    const client = createSlackClient(http);
    const items = [];
    let stopped: SlackChannelUnresolvedReason | undefined;
    for (const id of channelIds) {
      if (!hasChannelName(id)) {
        items.push(unavailable(id, 'not_a_channel'));
        continue;
      }
      if (stopped !== undefined) {
        items.push(unavailable(id, stopped));
        continue;
      }
      const result = await lookupChannel(client, botToken, id, signal);
      if (result.kind === 'succeeded') {
        items.push({ value: id, label: result.name });
        continue;
      }
      const reason = unresolvedReason(result);
      items.push(unavailable(id, reason));
      if (reason !== 'not_found') stopped = reason;
    }
    return { items };
  },
});

async function lookupChannel(
  client: SlackClient,
  botToken: string,
  channelId: string,
  signal: AbortSignal,
) {
  try {
    return await client.lookupChannel({
      botToken,
      channelId,
      timeoutMillis: CHANNEL_LOOKUP_CALL_TIMEOUT_MILLIS,
      signal,
      beforeDispatch: () => Promise.resolve(),
    });
  } catch (error: unknown) {
    // Preserve names already read when the shared deadline interrupts a call.
    if (signal.aborted || error instanceof ProviderHttpError)
      return { kind: 'invalid_response' } as const;
    throw error;
  }
}

function unresolvedReason(
  result: Exclude<
    Awaited<ReturnType<SlackClient['lookupChannel']>>,
    { kind: 'succeeded' }
  >,
): SlackChannelUnresolvedReason {
  if (result.kind === 'rate_limited') return 'rate_limited';
  if (result.kind === 'rejected') {
    if (result.error === 'channel_not_found') return 'not_found';
    if (result.error === 'missing_scope') return 'missing_scope';
    if (slackRejection(result.error)?.errorKind === 'authentication')
      return 'connection_unavailable';
  }
  return 'provider_unavailable';
}

function hasChannelName(id: string) {
  return id.startsWith('C') || id.startsWith('G');
}

function unavailable(id: string, reason: SlackChannelUnresolvedReason) {
  return {
    value: id,
    label: id,
    unavailableReason: hasChannelName(id) ? reason : 'not_a_channel',
  };
}
