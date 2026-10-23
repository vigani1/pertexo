import { resolveAttemptCallbacks } from './callbacks.js';

import type { NodeExecutionResult } from '@pertexo/node-sdk/server';

import { WorkflowEngineError } from '../errors.js';

import { assertAuthenticExecutableIdentity } from '../compilation/foundation.js';
import { normalizeBoundedEngineValue } from '../compilation/validation.js';

import { operationError } from '../operation-values.js';

import { prepareNodeAttemptInput } from './input.js';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
} from './contract.js';

import { isCoreMergeDefinition } from '../core-definition-identities.js';

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
  const {
    node,
    runInput,
    variables,
    completedOutputs,
    directUpstream,
    structuredInputs,
    sourceFailure,
  } = prepareNodeAttemptInput(input);
  const callbacks = await resolveAttemptCallbacks(input, node);
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
  };
}
