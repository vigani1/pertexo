import {
  connectionLookupRequestSchema,
  slackChannelLookupInputSchema,
} from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';

// A Slack connection and its ADR 046 channel-name lookup, for the places
// that show `#channel-name` instead of a channel ID.

type Answer =
  Readonly<{ name: string }> | Readonly<{ reason: string }> | undefined;

export function slackConnection(
  workspaceId: string,
  id: string,
  name = 'Ops bot',
) {
  return {
    id,
    workspaceId,
    providerKey: 'slack',
    name,
    authType: 'slack_bot_token',
    status: 'active',
    secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

/**
 * Answers name lookups on any connection of the workspace at `workspaceApi`:
 * a channel in `answers` resolves to its name or stays unresolved with its
 * reason; any other one isn't found. Every lookup's `channelIds` is kept.
 */
export function slackChannelLookup(
  workspaceApi: string,
  answers: Readonly<Record<string, Answer>>,
  lookups: string[] = [],
) {
  return http.post(
    `${workspaceApi}/connections/:connectionId/lookup`,
    async ({ request }) => {
      const lookup = connectionLookupRequestSchema.parse(await request.json());
      if (lookup.providerKey !== 'slack' || lookup.lookup !== 'channels')
        return new HttpResponse(null, { status: 400 });
      const { channelIds } = slackChannelLookupInputSchema.parse(lookup.input);
      lookups.push(channelIds.join(','));
      return HttpResponse.json({
        items: channelIds.map((channelId) => {
          const answer = answers[channelId];
          if (answer !== undefined && 'name' in answer)
            return { value: channelId, label: answer.name };
          return {
            value: channelId,
            label: channelId,
            unavailableReason: answer?.reason ?? 'not_found',
          };
        }),
      });
    },
  );
}
