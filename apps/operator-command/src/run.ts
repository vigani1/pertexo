import type {
  OperatorCommandDatabase,
  OperatorCommandRecord,
  OperatorCommandResult,
  RedispatchFailedOutboxInput,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

export interface OperatorCommandResources {
  readonly cleanupTimeoutMs: number;
  readonly command:
    | (Omit<RedispatchFailedOutboxInput, 'signal'> & {
        readonly type: 'outbox.redispatch';
      })
    | Readonly<{
        actorRef: string;
        commandId: string;
        reason: string;
        type: 'operator.status';
        workspaceId: string;
      }>;
  readonly database: OperatorCommandDatabase;
  readonly logger: StructuredLogger;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

async function boundedCleanup(
  operation: Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} cleanup timed out`));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runOperatorCommand(
  resources: OperatorCommandResources,
): Promise<OperatorCommandResult | OperatorCommandRecord | null> {
  let result: OperatorCommandResult | OperatorCommandRecord | null | undefined;
  let operationError: unknown;
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    await resources.database.checkReadiness(resources.signal);
    result =
      resources.command.type === 'operator.status'
        ? await resources.database.getCommand({
            actorRef: resources.command.actorRef,
            commandId: resources.command.commandId,
            reason: resources.command.reason,
            signal: resources.signal,
            workspaceId: resources.command.workspaceId,
          })
        : await resources.database.redispatchFailedOutbox({
            actorRef: resources.command.actorRef,
            commandId: resources.command.commandId,
            dryRun: resources.command.dryRun,
            outboxEventId: resources.command.outboxEventId,
            reason: resources.command.reason,
            signal: resources.signal,
            workspaceId: resources.command.workspaceId,
          });
    resources.logger.info('operator_command.completed', {
      commandType: resources.command.type,
      ...(resources.command.type === 'outbox.redispatch'
        ? { dryRun: resources.command.dryRun }
        : {}),
      outcome: result === null ? 'not_found' : result.outcome,
      ...('replayed' in (result ?? {})
        ? { replayed: (result as OperatorCommandResult).replayed }
        : {}),
    });
  } catch (error: unknown) {
    operationError = error;
    resources.logger.error(
      'operator_command.failed',
      {
        commandType: resources.command.type,
        ...(resources.command.type === 'outbox.redispatch'
          ? { dryRun: resources.command.dryRun }
          : {}),
        errorType: error instanceof Error ? error.name : typeof error,
      },
      error,
    );
  }

  const cleanupErrors: unknown[] = [];
  try {
    await boundedCleanup(
      resources.database.close(),
      resources.cleanupTimeoutMs,
      'Database',
    );
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  try {
    await boundedCleanup(
      resources.telemetry.shutdown(),
      resources.cleanupTimeoutMs,
      'Telemetry',
    );
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [
        ...(operationError === undefined ? [] : [operationError]),
        ...cleanupErrors,
      ],
      'Operator command did not complete cleanly',
    );
  }
  if (result === undefined)
    throw new Error('Operator command produced no result');
  return result;
}
