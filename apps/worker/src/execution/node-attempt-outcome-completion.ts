import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptLease,
} from '@pertexo/database/execution';
import type { NodeAttemptOutcome } from '@pertexo/workflow-engine';
import type {
  NodeAttemptHandlerDependencies,
  NodeAttemptHandlerResult,
  PreparedNodeAttempt,
} from './node-attempt-handler.js';
import type { NodeExecutionEnvironment } from './node-attempt-execution-environment.js';
import { connectionHealthCompletionFields } from './connection-health-completion.js';
import { completionResult } from './node-attempt-completion-result.js';

/** Preserve the separate Call input alias and ordinary physical-output owner. */
export async function persistPreparedNodeAttemptOutcome(
  dependencies: Pick<
    NodeAttemptHandlerDependencies,
    'runStore' | 'notifications' | 'connectionRunHealthMode'
  >,
  lease: NodeAttemptLease,
  prepared: Pick<
    PreparedNodeAttempt,
    'inputPersistence' | 'suspensionDurationSeconds'
  >,
  outcome: NodeAttemptOutcome,
  traceContext: Readonly<{ traceparent?: string }>,
  contextSignal: AbortSignal,
  environment: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult> {
  if (prepared.inputPersistence === 'workflow_call_declaration') {
    const complete = dependencies.runStore.completeCallDeclaration?.bind(
      dependencies.runStore,
    );
    if (
      complete === undefined ||
      prepared.suspensionDurationSeconds !== undefined
    )
      throw new TypeError('Native Call input alias completion is unavailable');
    const completed = await complete({
      lease,
      ...traceContext,
      signal: contextSignal,
    });
    return completionResult(dependencies, lease, completed.kind);
  }
  try {
    const completed = await dependencies.runStore.complete({
      ...connectionHealthCompletionFields(dependencies, environment),
      lease,
      outcome:
        prepared.suspensionDurationSeconds === undefined
          ? { status: 'succeeded', output: outcome.output }
          : {
              status: 'suspended',
              output: outcome.output,
              durationSeconds: prepared.suspensionDurationSeconds,
            },
      ...traceContext,
      signal: contextSignal,
    });
    return await completionResult(dependencies, lease, completed.kind);
  } catch (error: unknown) {
    if (!(error instanceof NodeAttemptOutputInvalidError)) throw error;
    const completed = await dependencies.runStore.complete({
      ...connectionHealthCompletionFields(dependencies, environment),
      lease,
      outcome: {
        status: 'failed',
        safeErrorCode: 'execution.output_invalid',
      },
      ...traceContext,
      signal: contextSignal,
    });
    return completionResult(dependencies, lease, completed.kind);
  }
}
