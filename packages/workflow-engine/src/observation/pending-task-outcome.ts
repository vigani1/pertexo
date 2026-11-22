import { normalizeBoundedEngineJson } from '../compilation/executable.validation.js';
import {
  UUID_PATTERN,
  WORKFLOW_GRAPH_LIMITS,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  type JsonValue,
} from '@pertexo/workflow-model';
import {
  exactKeys,
  operationError,
  record,
} from '../input-checks/engine-values.js';
import { parseBranchPath, parseIterationPath } from '../checkpoint/fields.js';
import type { PendingTaskOutcome } from '../workflow-execution.js';

export function parseTaskOutcome(value: JsonValue): PendingTaskOutcome {
  const fact = record(value, 'observation_invalid', 'task outcome');
  const { taskId, invocationKey, nodeId } = fact;

  exactKeys(
    fact,
    ['taskId', 'invocationKey', 'nodeId', 'status'],
    ['branchPath', 'iterationPath'],
  );
  const invalidTaskIdentity =
    typeof taskId !== 'string' ||
    !UUID_PATTERN.test(taskId) ||
    typeof invocationKey !== 'string' ||
    invocationKey.length === 0 ||
    invocationKey.length > WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength ||
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    typeof fact.status !== 'string' ||
    ![
      'approved',
      'rejected',
      'submitted',
      'expired',
      'refused',
      'canceled',
    ].includes(fact.status);
  if (invalidTaskIdentity)
    operationError('observation_invalid', 'task outcome identity is invalid');
  return {
    taskId: taskId,
    invocationKey: invocationKey,
    nodeId: nodeId,
    status: fact.status as PendingTaskOutcome['status'],
    branchPath: parseBranchPath(fact.branchPath, 'invocation'),
    iterationPath: parseIterationPath(fact.iterationPath, 'invocation'),
  };
}

export function readTaskOutcomeWindow(input: unknown): readonly JsonValue[] {
  let bounded: JsonValue;
  try {
    bounded = normalizeBoundedEngineJson(input ?? []);
  } catch {
    operationError('observation_invalid', 'task outcomes are invalid');
  }
  if (
    !Array.isArray(bounded) ||
    bounded.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations
  )
    operationError('observation_invalid', 'task outcome window is invalid');
  return bounded as readonly JsonValue[];
}
