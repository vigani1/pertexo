import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { useQueries } from '@tanstack/react-query';
import { slackChannelNamesQueryOptions } from '@/features/connections/queries.public';
import type { ApiClient } from '@/lib/api/client';
import {
  channelLookups,
  channelNamesFrom,
  type ChannelNames,
} from './model/channel-names';

/**
 * Display names for the Slack channels the destinations post to, one
 * bounded lookup per connection (ADR 046). Names are hints: a failed or
 * refused lookup leaves the channel ID on screen, never the page failing.
 */
export function useSlackChannelNames({
  apiClient,
  userId,
  workspaceId,
  destinations,
  enabled,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  destinations: readonly Pick<
    FailureNotificationDestinationResponse,
    'config'
  >[];
  enabled: boolean;
}>): ChannelNames {
  const lookups = channelLookups(destinations);
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
