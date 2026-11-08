import type { ConnectionResponse, ApiProblemIssue } from '@pertexo/contracts';
import {
  failureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationResponse,
} from '@pertexo/contracts';
import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';
import {
  channelKey,
  describeChannel,
  type ChannelNames,
} from './channel-names';

export type DestinationKind = FailureNotificationDestinationResponse['kind'];
export type DestinationField = 'connection' | 'target';
export type DestinationErrors = Readonly<
  Partial<Record<DestinationField, string | undefined>>
>;

function destinationTarget(
  config: FailureNotificationDestinationConfig,
  names: ChannelNames,
): Readonly<{ target: string; note: string | undefined }> {
  if (config.kind === 'system_mail')
    return { target: `Member ${config.memberId.slice(0, 8)}`, note: undefined };
  return config.kind === 'slack'
    ? describeChannel(
        config.channelId,
        names.get(channelKey(config.connectionId, config.channelId)),
      )
    : { target: config.toEmail, note: undefined };
}

/**
 * "#ops-alerts via Ops bot" or "oncall@northwind.dev via Receipts". A Slack
 * channel whose name isn't known shows its ID, with why when a lookup said.
 */
export function describeDestination(
  destination: Pick<FailureNotificationDestinationResponse, 'config'>,
  connections: readonly ConnectionResponse[],
  names: ChannelNames = new Map(),
  members: readonly Readonly<{
    userId: string;
    email: string;
    displayName: string;
  }>[] = [],
): Readonly<{
  label: string;
  connectionProblem: string | undefined;
  channelNote: string | undefined;
}> {
  if (destination.config.kind === 'system_mail') {
    const memberId = destination.config.memberId;
    const member = members.find((person) => person.userId === memberId);
    const target =
      member === undefined
        ? `Member ${memberId.slice(0, 8)}`
        : `${member.displayName} · ${member.email}`;
    return {
      label: `${target} via this server's mail`,
      connectionProblem: undefined,
      channelNote: undefined,
    };
  }
  const config = destination.config;
  const connection = connections.find(
    (candidate) => candidate.id === config.connectionId,
  );
  const via = connection?.name ?? 'a connection you can’t see';
  let connectionProblem: string | undefined;
  if (connection?.status === 'revoked')
    connectionProblem = `${connection.name} was revoked, so these alerts can’t be sent.`;
  else if (connection?.status === 'reauthorization_required')
    connectionProblem = `${connection.name} needs reconnecting before these alerts can be sent.`;
  const { target, note } = destinationTarget(destination.config, names);
  return {
    label: `${target} via ${via}`,
    connectionProblem,
    // A connection problem already explains why the name can't be read.
    channelNote: connectionProblem === undefined ? note : undefined,
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
  if (kind === 'system_mail')
    return failureNotificationDestinationConfigSchema.safeParse({
      kind,
      memberId: value,
    }).success
      ? undefined
      : 'Choose a workspace member.';
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
  if (kind === 'system_mail') return undefined;
  const usable = usableConnections(connections, kind);
  if (usable.some((connection) => connection.id === connectionId))
    return undefined;
  if (usable.length === 0)
    return kind === 'slack'
      ? 'Add a Slack connection first, then pick it here.'
      : 'Add a Resend or SMTP email connection first, then pick it here.';
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
  connectionId: string | null,
  target: string,
): FailureNotificationDestinationConfig {
  const value = target.trim().replace(/^#/u, '');
  if (kind === 'system_mail')
    return failureNotificationDestinationConfigSchema.parse({
      kind,
      memberId: value,
    });
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
  const targetField = {
    slack: 'channelId',
    email: 'toEmail',
    system_mail: 'memberId',
  }[kind];
  if (kind === 'system_mail') {
    for (const issue of issues)
      if (issue.path.split(/[/.]/u).at(-1) === 'memberId')
        errors.target = 'Choose a current workspace member.';
    return errors;
  }
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

/** The input draft for a saved destination; server mail has no connection. */
export function destinationFormValues(
  config: FailureNotificationDestinationConfig,
) {
  switch (config.kind) {
    case 'system_mail':
      return { kind: config.kind, connectionId: null, target: config.memberId };
    case 'slack':
      return {
        kind: config.kind,
        connectionId: config.connectionId,
        target: config.channelId,
      };
    case 'email':
      return {
        kind: config.kind,
        connectionId: config.connectionId,
        target: config.toEmail,
      };
  }
}

export function canAddAlert(
  connections: readonly ConnectionResponse[],
  kind: DestinationKind,
  systemMailAvailable: boolean,
): boolean {
  if (kind === 'system_mail') return systemMailAvailable;
  return usableConnections(connections, kind).length > 0;
}
