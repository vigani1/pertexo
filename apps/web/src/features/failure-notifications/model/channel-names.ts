import {
  SLACK_CHANNEL_LOOKUP_LIMIT,
  type SlackChannelLookupResponse,
  type SlackChannelUnresolvedReason,
} from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';

/** What the page knows about one Slack channel's display name. */
export type ChannelName =
  | Readonly<{ status: 'resolved'; name: string }>
  | Readonly<{
      status: 'unresolved';
      reason: SlackChannelUnresolvedReason | 'lookup_failed';
    }>;
export type ChannelNames = ReadonlyMap<string, ChannelName>;

/** One bounded name lookup: a connection and up to ten of its channels. */
export type ChannelLookup = Readonly<{
  connectionId: string;
  channelIds: readonly string[];
}>;

type LookupResult = Readonly<{
  data: SlackChannelLookupResponse | undefined;
  isError: boolean;
}>;

const WHY_NOT_SHOWN: Readonly<
  Record<Extract<ChannelName, { status: 'unresolved' }>['reason'], string>
> = {
  missing_scope:
    'The Slack app needs the channels:read scope (groups:read for private channels) to show names.',
  not_found: 'Slack can’t find this channel, or the bot isn’t in it.',
  connection_unavailable: 'This connection can’t look up channel names.',
  rate_limited: 'Slack asked Pertexo to slow down. Names come back shortly.',
  provider_unavailable: 'Slack didn’t answer the name lookup. Try again later.',
  not_a_channel: 'Direct messages don’t have channel names.',
  lookup_failed: 'Channel names couldn’t be looked up right now.',
};

export function channelKey(connectionId: string, channelId: string): string {
  return `${connectionId}:${channelId}`;
}

/** Each connection's distinct Slack channels, in groups the API accepts. */
export function channelLookups(
  destinations: readonly Pick<
    FailureNotificationDestinationResponse,
    'config'
  >[],
): readonly ChannelLookup[] {
  const channels = new Map<string, Set<string>>();
  for (const { config } of destinations) {
    if (config.kind !== 'slack') continue;
    const ids = channels.get(config.connectionId) ?? new Set<string>();
    ids.add(config.channelId);
    channels.set(config.connectionId, ids);
  }
  return [...channels.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([connectionId, ids]) => {
      const sorted = [...ids].sort();
      const lookups: ChannelLookup[] = [];
      for (
        let start = 0;
        start < sorted.length;
        start += SLACK_CHANNEL_LOOKUP_LIMIT
      )
        lookups.push({
          connectionId,
          channelIds: sorted.slice(start, start + SLACK_CHANNEL_LOOKUP_LIMIT),
        });
      return lookups;
    });
}

/** Every answered or failed lookup, keyed by connection and channel. */
export function channelNamesFrom(
  lookups: readonly ChannelLookup[],
  results: readonly LookupResult[],
): ChannelNames {
  const names = new Map<string, ChannelName>();
  lookups.forEach(({ connectionId, channelIds }, index) => {
    const result = results[index];
    if (result?.data !== undefined)
      for (const item of result.data.items)
        names.set(
          channelKey(connectionId, item.channelId),
          item.status === 'resolved'
            ? { status: 'resolved', name: item.name }
            : { status: 'unresolved', reason: item.reason },
        );
    else if (result?.isError === true)
      for (const channelId of channelIds)
        names.set(channelKey(connectionId, channelId), {
          status: 'unresolved',
          reason: 'lookup_failed',
        });
  });
  return names;
}

/**
 * "#ops-alerts" once the name is known; otherwise the channel ID, and why
 * its name isn't shown when a lookup answered.
 */
export function describeChannel(
  channelId: string,
  name: ChannelName | undefined,
): Readonly<{ target: string; note: string | undefined }> {
  if (name?.status === 'resolved')
    return { target: `#${name.name}`, note: undefined };
  return {
    target: `#${channelId}`,
    note:
      name === undefined
        ? undefined
        : `Showing the channel ID. ${WHY_NOT_SHOWN[name.reason]}`,
  };
}
