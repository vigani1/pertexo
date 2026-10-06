import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/execution';
import type { NodeAttemptHandlerDependencies } from './node-attempt-handler.js';
import { createWorkflowExecutionValueInlinePreparation } from './workflow-execution-value-codec.js';
import { normalize } from './workflow-execution-value-decoding.js';

function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

/** Same owned heartbeat lifetime; preparation never grants SQL acceptance. */
export async function prepareNodeAttemptPhysicalOutput(
  input: Readonly<{
    lease: NodeAttemptLease;
    native: boolean;
    callAlias: boolean;
    value: unknown;
    signal: AbortSignal;
    values: NodeAttemptHandlerDependencies['physicalOutputValues'];
  }>,
): Promise<Parameters<NodeAttemptRunStore['complete']>[0]['nativeOutput']> {
  if (!input.native || input.callAlias) return undefined;
  assertActive(input.signal);
  let value;
  try {
    value = normalize(input.value);
  } catch {
    throw new NodeAttemptOutputInvalidError();
  }
  const prepared = await (
    input.values ?? createWorkflowExecutionValueInlinePreparation()
  ).prepare({
    owner: { kind: 'attempt', slot: 'physical_output', lease: input.lease },
    value,
    signal: input.signal,
  });
  assertActive(input.signal);
  return prepared;
}
