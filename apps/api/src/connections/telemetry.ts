import {
  measureOperation,
  NOOP_OPERATION_TELEMETRY,
  type OperationTelemetry,
} from '@pertexo/observability';
export const CONNECTION_OPERATION = Object.freeze({
  list: 'connection.list',
  read: 'connection.read',
  usage: 'connection.usage.read',
  sharingRead: 'connection.sharing.read',
  sharingUpdate: 'connection.sharing.update',
  create: 'connection.create',
  rotate: 'connection.secret.rotate',
  revoke: 'connection.revoke',
  test: 'connection.test',
  slackChannelLookup: 'connection.slack_channel.lookup',
  destinationCreate: 'failure_notification_destination.create',
  destinationAppend: 'failure_notification_destination.version.append',
  destinationStatus: 'failure_notification_destination.status',
  policySet: 'workflow.failure_notification_policy.set',
  policyClear: 'workflow.failure_notification_policy.clear',
} as const);

export type ConnectionOperation =
  (typeof CONNECTION_OPERATION)[keyof typeof CONNECTION_OPERATION];
export type ConnectionOutcome = 'failed' | 'succeeded';

export type ConnectionTelemetry = OperationTelemetry<ConnectionOperation>;

export const NOOP_CONNECTION_TELEMETRY: ConnectionTelemetry =
  NOOP_OPERATION_TELEMETRY;

export type ConnectionTelemetryOptions = Readonly<{
  count(operation: ConnectionOperation, outcome: ConnectionOutcome): void;
  duration(
    operation: ConnectionOperation,
    outcome: ConnectionOutcome,
    seconds: number,
  ): void;
  trace<T>(operation: ConnectionOperation, work: () => Promise<T>): Promise<T>;
  monotonicNow?: () => number;
}>;

export function createConnectionTelemetry(
  options: ConnectionTelemetryOptions,
): ConnectionTelemetry {
  return Object.freeze({
    measure: <T>(
      operation: ConnectionOperation,
      work: () => Promise<T>,
    ): Promise<T> =>
      measureOperation({
        work,
        monotonicNow: options.monotonicNow,
        trace: (run) => options.trace(operation, run),
        record: ({ outcome, seconds }) => {
          try {
            options.count(operation, outcome);
          } catch {
            // Each diagnostic sink is independent of command truth and its peer.
          }
          try {
            options.duration(operation, outcome, seconds);
          } catch {
            // Diagnostics cannot change connection command truth.
          }
        },
      }),
  });
}
