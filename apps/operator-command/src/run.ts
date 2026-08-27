import type {
  OperatorCommandDatabase,
  OperatorCommandRecord,
  OperatorCommandResult,
  RedispatchFailedOutboxInput,
  ReplayOperatorRunInput,
  GenericOperatorCommandResult,
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
      }>
    | Readonly<{
        action: 'outcome_unknown' | 'reclaim';
        actorRef: string;
        attemptId: string;
        commandId: string;
        dryRun: boolean;
        expectedFenceToken: number;
        reason: string;
        type: 'attempt.reconcile';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        runId: string;
        type: 'due-work.resume' | 'run.cancel';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        attemptId: string;
        commandId: string;
        evidenceKind: string;
        evidenceRef: Readonly<Record<string, unknown>>;
        reason: string;
        type: 'unknown-outcome.record-evidence';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        type: 'trigger.reconcile';
        workflowId: string;
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        runInput: ReplayOperatorRunInput['runInput'];
        sourceRunId: string;
        type: 'run.replay';
        workflowVersionId: string;
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
): Promise<
  | OperatorCommandResult
  | GenericOperatorCommandResult
  | OperatorCommandRecord
  | null
> {
  let result:
    | OperatorCommandResult
    | GenericOperatorCommandResult
    | OperatorCommandRecord
    | null
    | undefined;
  let operationError: unknown;
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    await resources.database.checkReadiness(resources.signal);
    switch (resources.command.type) {
      case 'operator.status':
        result = await resources.database.getCommand({
          actorRef: resources.command.actorRef,
          commandId: resources.command.commandId,
          reason: resources.command.reason,
          signal: resources.signal,
          workspaceId: resources.command.workspaceId,
        });
        break;
      case 'outbox.redispatch':
        result = await resources.database.redispatchFailedOutbox({
          actorRef: resources.command.actorRef,
          commandId: resources.command.commandId,
          dryRun: resources.command.dryRun,
          outboxEventId: resources.command.outboxEventId,
          reason: resources.command.reason,
          signal: resources.signal,
          workspaceId: resources.command.workspaceId,
        });
        break;
      case 'attempt.reconcile':
        result = await resources.database.reconcileAttempt({
          ...resources.command,
          signal: resources.signal,
        });
        break;
      case 'due-work.resume':
        result = await resources.database.resumeDueWork({
          ...resources.command,
          signal: resources.signal,
        });
        break;
      case 'run.cancel':
        result = await resources.database.cancelRun({
          ...resources.command,
          signal: resources.signal,
        });
        break;
      case 'unknown-outcome.record-evidence':
        result = await resources.database.recordUnknownOutcomeEvidence({
          ...resources.command,
          signal: resources.signal,
        });
        break;
      case 'trigger.reconcile':
        result = await resources.database.retryTriggerReconciliation({
          ...resources.command,
          signal: resources.signal,
        });
        break;
      case 'run.replay':
        result = await resources.database.replayRun({
          ...resources.command,
          signal: resources.signal,
        });
        break;
    }
    resources.logger.info('operator_command.completed', {
      commandType: resources.command.type,
      ...('dryRun' in resources.command
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
        ...('dryRun' in resources.command
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
