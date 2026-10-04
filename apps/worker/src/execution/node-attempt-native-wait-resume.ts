import type { NodeAttemptLease } from '@pertexo/database/execution';
import type {
  NodeAttemptHandlerDependencies,
  NodeAttemptHandlerResult,
} from './node-attempt-handler.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import { prepareNodeAttemptPhysicalOutput } from './node-attempt-physical-output.js';
import { completionResult } from './node-attempt-completion-result.js';

/** Native Wait resumes the accepted output without redispatching its executor.
 * Preparation and control inspection remain in the caller's owned heartbeat lifetime.
 */
export async function completeNativeWaitResume(
  input: Readonly<{
    dependencies: NodeAttemptHandlerDependencies;
    lease: NodeAttemptLease;
    value: unknown;
    executionSignal: AbortSignal;
    completionSignal: AbortSignal;
    traceContext: Readonly<{ traceparent?: string }>;
    inspectInterruption: () => Promise<NodeAttemptHandlerResult | undefined>;
  }>,
): Promise<NodeAttemptHandlerResult> {
  if (input.value === undefined || input.lease.admissionKind !== 'wait_resume')
    throw new NodeAttemptHandlerStateError('wait_resume_output_missing');
  const nativeOutput = await prepareNodeAttemptPhysicalOutput({
    lease: input.lease,
    native: true,
    callAlias: false,
    value: input.value,
    signal: input.executionSignal,
    values: input.dependencies.physicalOutputValues,
  });
  const interruption = await input.inspectInterruption();
  if (interruption !== undefined) return interruption;
  const completed = await input.dependencies.runStore.complete({
    lease: input.lease,
    ...(nativeOutput === undefined ? {} : { nativeOutput }),
    outcome: { status: 'succeeded', output: input.value },
    ...input.traceContext,
    signal: input.completionSignal,
  });
  return completionResult(input.dependencies, input.lease, completed.kind);
}
