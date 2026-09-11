import type {
  OperatorCommandDatabase,
  OperatorCommandRecord,
  OperatorCommandResult,
  GenericOperatorCommandResult,
} from '@pertexo/database/operator';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

import type { OperatorCommandConfig } from './config.js';

export interface OperatorCommandResources {
  readonly cleanupTimeoutMs: number;
  readonly command: OperatorCommandConfig['command'];
  readonly database: OperatorCommandDatabase;
  readonly logger: StructuredLogger;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

type OperatorCommandExecutionResult =
  | OperatorCommandResult
  | GenericOperatorCommandResult
  | OperatorCommandRecord
  | null;

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

async function executeConfiguredCommand(
  resources: OperatorCommandResources,
): Promise<OperatorCommandExecutionResult> {
  switch (resources.command.type) {
    case 'operator.status':
      return resources.database.getCommand({
        actorRef: resources.command.actorRef,
        commandId: resources.command.commandId,
        reason: resources.command.reason,
        signal: resources.signal,
        workspaceId: resources.command.workspaceId,
      });
    case 'outbox.redispatch':
      return resources.database.redispatchFailedOutbox({
        actorRef: resources.command.actorRef,
        commandId: resources.command.commandId,
        dryRun: resources.command.dryRun,
        outboxEventId: resources.command.outboxEventId,
        reason: resources.command.reason,
        signal: resources.signal,
        workspaceId: resources.command.workspaceId,
      });
    case 'attempt.reconcile':
      return resources.database.reconcileAttempt({
        ...resources.command,
        signal: resources.signal,
      });
    case 'due-work.resume':
      return resources.database.resumeDueWork({
        ...resources.command,
        signal: resources.signal,
      });
    case 'run.cancel':
      return resources.database.cancelRun({
        ...resources.command,
        signal: resources.signal,
      });
    case 'unknown-outcome.record-evidence':
      return resources.database.recordUnknownOutcomeEvidence({
        ...resources.command,
        signal: resources.signal,
      });
    case 'trigger.reconcile':
      return resources.database.retryTriggerReconciliation({
        ...resources.command,
        signal: resources.signal,
      });
    case 'run.replay':
      return resources.database.replayRun({
        ...resources.command,
        signal: resources.signal,
      });
    case 'purge.rerun':
    case 'retention.rerun':
      return resources.database.requestMaintenanceRerun({
        ...resources.command,
        signal: resources.signal,
      });
  }
}

async function cleanupOperatorResources(
  resources: OperatorCommandResources,
): Promise<readonly unknown[]> {
  const cleanupErrors: unknown[] = [];
  for (const [label, close] of [
    ['Database', () => resources.database.close()],
    ['Telemetry', () => resources.telemetry.shutdown()],
  ] as const) {
    try {
      await boundedCleanup(close(), resources.cleanupTimeoutMs, label);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

export async function runOperatorCommand(
  resources: OperatorCommandResources,
): Promise<OperatorCommandExecutionResult> {
  let result: OperatorCommandExecutionResult | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    await resources.database.checkReadiness(resources.signal);
    result = await executeConfiguredCommand(resources);
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
    operationFailed = true;
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

  const cleanupErrors = await cleanupOperatorResources(resources);
  if (operationFailed || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(operationFailed ? [operationError] : []), ...cleanupErrors],
      'Operator command did not complete cleanly',
    );
  }
  if (result === undefined)
    throw new Error('Operator command produced no result');
  return result;
}
