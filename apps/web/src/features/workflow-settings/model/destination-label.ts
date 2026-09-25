import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import {
  channelKey,
  describeChannel,
  type ChannelNames,
} from '@/features/failure-notifications/channel-names.public';

type Destination = Pick<FailureNotificationDestinationResponse, 'config'>;

const noChannelNames: ChannelNames = new Map();

/**
 * A destination in words: "Email to ops@example.com via Ops mail",
 * "#ops-alerts via Ops bot" once the channel's name is known (ADR 046), or
 * "Slack channel C0123 via Ops bot". Connection names are added when known.
 */
export function describeDestination(
  destination: Destination,
  connectionNames: ReadonlyMap<string, string>,
  channelNames: ChannelNames = noChannelNames,
): string {
  const { config } = destination;
  const target =
    config.kind === 'email'
      ? `Email to ${config.toEmail}`
      : slackTarget(config.connectionId, config.channelId, channelNames);
  const connection = connectionNames.get(config.connectionId);
  return connection === undefined ? target : `${target} via ${connection}`;
}

function slackTarget(
  connectionId: string,
  channelId: string,
  channelNames: ChannelNames,
): string {
  const name = channelNames.get(channelKey(connectionId, channelId));
  return name?.status === 'resolved'
    ? describeChannel(channelId, name).target
    : `Slack channel ${channelId}`;
}

/** Why a Slack destination shows its channel ID rather than its name. */
export function channelNameNote(
  destination: Destination,
  channelNames: ChannelNames,
): string | undefined {
  const { config } = destination;
  if (config.kind !== 'slack') return undefined;
  return describeChannel(
    config.channelId,
    channelNames.get(channelKey(config.connectionId, config.channelId)),
  ).note;
}
