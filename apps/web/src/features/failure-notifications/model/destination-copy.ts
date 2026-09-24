import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import {
  failureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
  type FailureNotificationDestinationResponse,
} from '@pertexo/contracts/schemas/failure-notifications';
import type { ApiProblemIssue } from '@pertexo/contracts/schemas/errors';

export type DestinationKind = FailureNotificationDestinationResponse['kind'];
export type DestinationField = 'connection' | 'target';
export type DestinationErrors = Readonly<
  Partial<Record<DestinationField, string | undefined>>
>;

function destinationTarget(
  config: FailureNotificationDestinationConfig,
): string {
  return config.kind === 'slack' ? `#${config.channelId}` : config.toEmail;
}

/** "#C0123 via Ops bot" or "oncall@northwind.dev via Receipts". */
export function describeDestination(
  destination: Pick<FailureNotificationDestinationResponse, 'config'>,
  connections: readonly ConnectionResponse[],
): Readonly<{ label: string; connectionProblem: string | undefined }> {
  const connection = connections.find(
    (candidate) => candidate.id === destination.config.connectionId,
  );
  const via = connection?.name ?? 'a connection you can’t see';
  let connectionProblem: string | undefined;
  if (connection?.status === 'revoked')
    connectionProblem = `${connection.name} was revoked, so these alerts can’t be sent.`;
  else if (connection?.status === 'reauthorization_required')
    connectionProblem = `${connection.name} needs reconnecting before these alerts can be sent.`;
  return {
    label: `${destinationTarget(destination.config)} via ${via}`,
    connectionProblem,
  };
}

/** Active connections that can deliver this kind of alert. */
export function usableConnections(
  connections: readonly ConnectionResponse[],
  kind: DestinationKind,
): readonly ConnectionResponse[] {
  return connections.filter(
    (connection) =>
      connection.providerKey === kind && connection.status === 'active',
  );
}

function targetError(
  kind: DestinationKind,
  target: string,
): string | undefined {
  const value = target.trim().replace(/^#/u, '');
  if (value === '')
    return kind === 'slack'
      ? 'Enter the channel ID, like C0123456789.'
      : 'Enter the email address alerts should go to.';
  const parsed = failureNotificationDestinationConfigSchema.safeParse(
    kind === 'slack'
      ? {
          kind,
          connectionId: '00000000-0000-4000-8000-000000000000',
          channelId: value,
        }
      : {
          kind,
          connectionId: '00000000-0000-4000-8000-000000000000',
          toEmail: value,
        },
  );
  if (parsed.success) return undefined;
  return kind === 'slack'
    ? 'Channel IDs start with C, G or D followed by capital letters and numbers, like C0123456789.'
    : 'That isn’t a complete email address, like oncall@yourdomain.com.';
}

function connectionError(
  kind: DestinationKind,
  connectionId: string | null,
  connections: readonly ConnectionResponse[],
): string | undefined {
  const usable = usableConnections(connections, kind);
  if (usable.some((connection) => connection.id === connectionId))
    return undefined;
  if (usable.length === 0)
    return kind === 'slack'
      ? 'Add a Slack connection first, then pick it here.'
      : 'Add a Resend email connection first, then pick it here.';
  return kind === 'slack'
    ? 'Choose the Slack connection that posts the alert.'
    : 'Choose the email connection that sends the alert.';
}

export function destinationErrors(
  kind: DestinationKind,
  connectionId: string | null,
  target: string,
  connections: readonly ConnectionResponse[],
): DestinationErrors {
  return {
    connection: connectionError(kind, connectionId, connections),
    target: targetError(kind, target),
  };
}

/** The destination configuration for a form with no errors. */
export function toDestinationConfig(
  kind: DestinationKind,
  connectionId: string,
  target: string,
): FailureNotificationDestinationConfig {
  const value = target.trim().replace(/^#/u, '');
  return failureNotificationDestinationConfigSchema.parse(
    kind === 'slack'
      ? { kind, connectionId, channelId: value }
      : { kind, connectionId, toEmail: value },
  );
}

/** Server issues (`connectionId`, `channelId`, `toEmail`) on their fields. */
export function destinationServerErrors(
  kind: DestinationKind,
  issues: readonly ApiProblemIssue[],
): DestinationErrors {
  const errors: Partial<Record<DestinationField, string>> = {};
  const targetField = kind === 'slack' ? 'channelId' : 'toEmail';
  for (const issue of issues) {
    const field = issue.path.split('.').at(-1);
    if (field === 'connectionId')
      errors.connection =
        'Pertexo can’t use this connection for alerts. Choose another.';
    else if (field === targetField)
      errors.target =
        kind === 'slack'
          ? 'Slack doesn’t accept this channel ID. Check it and try again.'
          : 'This email address can’t receive alerts. Check it and try again.';
  }
  return errors;
}
