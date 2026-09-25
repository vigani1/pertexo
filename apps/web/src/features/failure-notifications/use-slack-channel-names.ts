import { useQueries } from '@tanstack/react-query';
import { slackChannelNamesQueryOptions } from '@/features/connections/queries.public';
import type { ApiClient } from '@/lib/api/client';
import {
  channelLookups,
  channelNamesFrom,
  type ChannelNames,
  type SlackChannelRef,
} from './model/channel-names';

/**
 * Display names for Slack channels, one bounded lookup per connection and
 * group of ten channels (ADR 046). Names are hints: a failed or refused
 * lookup leaves the channel ID on screen, never the page failing.
 */
export function useSlackChannelNames({
  apiClient,
  userId,
  workspaceId,
  channels,
  enabled,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  channels: readonly SlackChannelRef[];
  enabled: boolean;
}>): ChannelNames {
  const lookups = channelLookups(channels);
  const results = useQueries({
    queries: lookups.map(({ connectionId, channelIds }) => ({
      ...slackChannelNamesQueryOptions(
        apiClient,
        userId,
        workspaceId,
        connectionId,
        channelIds,
      ),
      enabled,
    })),
  });
  return channelNamesFrom(lookups, results);
}
