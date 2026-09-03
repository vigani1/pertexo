import type {
  InvocationState,
  BranchSelection,
  WorkflowCheckpointV2,
} from './types.js';
import { compareOrdinal } from './ordering.js';
import {
  assertBoundedCheckpointJson,
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  parseV2Invocations,
} from './checkpoint-shared.js';
import { parseCheckpointV1Boundary } from './checkpoint-v1.js';

function parseBranchSelections(
  value: unknown,
  invocations: readonly InvocationState[],
): readonly BranchSelection[] {
  assertCheckpoint(Array.isArray(value), 'branchSelections must be an array');
  const invocationByKey = new Map(
    invocations.map((invocation) => [invocation.invocationKey, invocation]),
  );
  const selections = new Map<string, BranchSelection>();
  for (const selection of value) {
    assertCheckpoint(isRecord(selection), 'branch selection must be an object');
    assertExactKeys(selection, [
      'invocationKey',
      'nodeId',
      'selectedOutputPort',
    ]);
    assertCheckpoint(
      typeof selection.invocationKey === 'string' &&
        selection.invocationKey.length > 0,
      'branch selection invocationKey is required',
    );
    assertCheckpoint(
      typeof selection.nodeId === 'string' && selection.nodeId.length > 0,
      'branch selection nodeId is required',
    );
    assertCheckpoint(
      typeof selection.selectedOutputPort === 'string' &&
        selection.selectedOutputPort.length > 0,
      'branch selection output port is required',
    );
    const invocation = invocationByKey.get(selection.invocationKey);
    assertCheckpoint(
      invocation?.nodeId === selection.nodeId &&
        invocation.status === 'succeeded' &&
        invocation.output !== undefined,
      'branch selection requires a succeeded output-bearing invocation',
    );
    const key = `${selection.invocationKey}\u0000${selection.nodeId}`;
    const existing = selections.get(key);
    assertCheckpoint(
      existing === undefined ||
        existing.selectedOutputPort === selection.selectedOutputPort,
      'branch selection conflicts with an existing selection',
    );
    selections.set(key, {
      invocationKey: selection.invocationKey,
      nodeId: selection.nodeId,
      selectedOutputPort: selection.selectedOutputPort,
    });
  }
  return [...selections.values()].sort(
    (left, right) =>
      compareOrdinal(left.invocationKey, right.invocationKey) ||
      compareOrdinal(left.nodeId, right.nodeId),
  );
}

export function parseCheckpointV2Boundary(
  value: unknown,
): WorkflowCheckpointV2 {
  assertBoundedCheckpointJson(value);
  assertCheckpoint(isRecord(value), 'checkpoint must be an object');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'engineVersion',
      'workflowVersionId',
      'revision',
      'runStatus',
      'nextEventSequence',
      'readySet',
      'admittedInvocationKeys',
      'invocations',
      'joins',
      'loops',
      'remainingIterationBudget',
      'cancelRequested',
      'branchSelections',
    ],
    ['deadlineExpired', 'initialIterationBudget'],
  );
  const { branchSelections, initialIterationBudget, ...shared } = value;
  assertCheckpoint(
    typeof value.workflowVersionId === 'string',
    'workflowVersionId is required',
  );
  const invocations = parseV2Invocations(
    value.invocations,
    value.workflowVersionId,
  );
  const checkpoint = parseCheckpointV1Boundary({
    ...shared,
    invocations: invocations.map(
      ({ branchPath: _, iterationPath: __, ...invocation }) => {
        void _;
        void __;
        return invocation;
      },
    ),
    schemaVersion: 1,
  });
  assertCheckpoint(
    initialIterationBudget === undefined ||
      (isInteger(initialIterationBudget) && initialIterationBudget >= 0),
    'initialIterationBudget is invalid',
  );
  assertCheckpoint(
    checkpoint.loops.length === 0 || initialIterationBudget !== undefined,
    'loop checkpoint requires initialIterationBudget',
  );
  if (initialIterationBudget !== undefined)
    assertCheckpoint(
      checkpoint.remainingIterationBudget +
        checkpoint.loops.reduce(
          (total, loop) => total + loop.collectionSize,
          0,
        ) ===
        initialIterationBudget,
      'iteration budget accounting is inconsistent',
    );
  return {
    ...checkpoint,
    schemaVersion: 2,
    invocations,
    branchSelections: parseBranchSelections(branchSelections, invocations),
    ...(initialIterationBudget === undefined ? {} : { initialIterationBudget }),
  };
}
