import { isCoreMergeDefinition } from '@pertexo/workflow-model';
import { resolveAttemptCallbacks } from './callbacks.js';

import type { CallbackBindings } from '@pertexo/workflow-model';
import type { NodeExecutionResult } from '@pertexo/node-sdk/server';

import { WorkflowEngineError } from '../workflow-engine.errors.js';

import { assertAuthenticExecutableIdentity } from '../compilation/verified-executable.js';
import { normalizeBoundedEngineValue } from '../compilation/executable.validation.js';

import { operationError } from '../input-checks/engine-values.js';

import {
  prepareNodeAttemptInput,
  type PreparedNodeAttemptInput,
} from './prepare-attempt-input.js';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptInputSource,
  NodeAttemptOutcome,
} from './node-attempt.types.js';

import {
  assertIdentity,
  assertNotAborted,
  isAbortError,
  isNodeExecutorFailure,
} from './admission.js';
import { resolveMappedNodeInput } from './mapping.js';

export async function executeNodeAttempt(
  input: ExecuteNodeAttemptInput,
): Promise<NodeAttemptOutcome> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'attempt_invalid');
  assertIdentity(input.nodeRunId, 'nodeRunId', 'attempt_invalid');
  assertIdentity(input.attemptId, 'attemptId', 'attempt_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'attempt_invalid',
  );
  assertNotAborted(input.signal);
  const prepared = prepareNodeAttemptInput(input);
  const { node } = prepared;
  const callbacks = await resolveAttemptCallbacks(input, node);
  const executionInput = await mapPreparedAttemptInput(
    input,
    prepared,
    callbacks,
  );
  // Recorded before the executor runs, so failed attempts keep it (ADR 052).
  await input.onInputResolved?.(executionInput);
  assertNotAborted(input.signal);
  let result: NodeExecutionResult;
  try {
    result = await input.registry.execute({
      definition: node.definition,
      executor: node.executor,
      config: node.config,
      input: executionInput,
      connectionRefs: node.connectionRefs,
      signal: input.signal,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    if (isNodeExecutorFailure(error)) throw error;
    // The cause carries the step's own reason, when it gave one.
    throw new WorkflowEngineError('attempt_invalid', 'node execution failed', {
      cause: error,
    });
  }
  return {
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: node.id,
    kind: result.kind,
    output: result.output,
    ...(result.modelUsage === undefined
      ? {}
      : { modelUsage: result.modelUsage }),
  };
}

export async function mapPreparedAttemptInput(
  input: Pick<
    NodeAttemptInputSource,
    'signal' | 'expressionEvaluator' | 'coordinatorInput'
  >,
  prepared: PreparedNodeAttemptInput,
  callbacks?: CallbackBindings,
) {
  const {
    node,
    runInput,
    variables,
    completedOutputs,
    directUpstream,
    structuredInputs,
    sourceFailure,
  } = prepared;
  const resolvedInput = await resolveMappedNodeInput(
    isCoreMergeDefinition(node.definition)
      ? { ...node, inputMappings: {} }
      : node,
    {
      runInput: runInput,
      completedOutputs: completedOutputs,
      directUpstream: directUpstream,
      signal: input.signal,
      expressionEvaluator: input.expressionEvaluator,
      structuredInputs: structuredInputs,
      sourceFailure: sourceFailure,
      variables: variables,
      callbacks: callbacks,
    },
  );
  let executionInput = resolvedInput;
  if (isCoreMergeDefinition(node.definition)) {
    if (input.coordinatorInput === undefined)
      operationError('attempt_invalid', 'settled Merge input is missing');
    try {
      executionInput = normalizeBoundedEngineValue(input.coordinatorInput);
    } catch {
      operationError('attempt_invalid', 'settled Merge input is invalid');
    }
  }
  return executionInput;
}
