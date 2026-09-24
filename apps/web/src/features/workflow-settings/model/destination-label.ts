import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';

/**
 * A destination in words: "Email to ops@example.com via Ops mail" or
 * "Slack channel C0123 via Ops bot". Connection names are added when known.
 */
export function describeDestination(
  destination: Pick<FailureNotificationDestinationResponse, 'config'>,
  connectionNames: ReadonlyMap<string, string>,
): string {
  const { config } = destination;
  const target =
    config.kind === 'email'
      ? `Email to ${config.toEmail}`
      : `Slack channel ${config.channelId}`;
  const connection = connectionNames.get(config.connectionId);
  return connection === undefined ? target : `${target} via ${connection}`;
}
