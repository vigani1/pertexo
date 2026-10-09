import type {
  BranchSelection,
  InvocationState,
  WorkflowCheckpoint,
} from '../types.js';
import { WorkflowEngineError } from '../errors.js';
import { compareOrdinal } from '../ordering.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  isRunStatus,
  parseInvocations,
  sortedUnique,
} from './fields.js';
import {
  assertPersistedEngineVersion,
  assertPersistedWorkflowVersionId,
} from './identity.js';
import { parseJoin } from './joins.js';
import { parseLoop } from './loops.js';

type CheckpointLoop = WorkflowCheckpoint['loops'][number];
type CheckpointInvocation = WorkflowCheckpoint['invocations'][number];

function loopParentStatusIsConsistent(
  loop: CheckpointLoop,
  parent: CheckpointInvocation,
  cancelRequested: boolean,
  deadlineExpired: boolean,
): boolean {
  if (loop.terminalStatus !== undefined)
    return parent.status === loop.terminalStatus;
  if (cancelRequested && parent.status === 'canceled') return true;
  if (deadlineExpired && parent.status === 'timed_out') return true;
  const loopComplete =
    loop.nextOrdinal === loop.collectionSize &&
    loop.activeOrdinals.length === 0;
  return loopComplete
    ? parent.status === 'succeeded'
    : parent.status === 'pending' || parent.status === 'waiting';
}

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

export function parseCheckpointRecord(value: unknown): WorkflowCheckpoint {
  if (!isRecord(value) || value.schemaVersion !== 2)
    throw new WorkflowEngineError(
      'checkpoint_unsupported',
      `Unsupported checkpoint schema version: ${String(isRecord(value) ? value.schemaVersion : undefined)}`,
    );
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
  const engineVersion = assertPersistedEngineVersion(value.engineVersion);
  const workflowVersionId = assertPersistedWorkflowVersionId(
    value.workflowVersionId,
  );
  assertCheckpoint(
    isInteger(value.revision) && value.revision >= 0,
    'revision is invalid',
  );
  assertCheckpoint(isRunStatus(value.runStatus), 'runStatus is invalid');
  assertCheckpoint(
    isInteger(value.nextEventSequence) && value.nextEventSequence > 0,
    'nextEventSequence is invalid',
  );
  assertCheckpoint(Array.isArray(value.readySet), 'readySet must be an array');
  assertCheckpoint(
    Array.isArray(value.admittedInvocationKeys),
    'admittedInvocationKeys must be an array',
  );
  assertCheckpoint(
    Array.isArray(value.invocations),
    'invocations must be an array',
  );
  assertCheckpoint(Array.isArray(value.joins), 'joins must be an array');
  assertCheckpoint(Array.isArray(value.loops), 'loops must be an array');
  assertCheckpoint(
    isInteger(value.remainingIterationBudget) &&
      value.remainingIterationBudget >= 0,
    'remainingIterationBudget is invalid',
  );
  assertCheckpoint(
    typeof value.cancelRequested === 'boolean',
    'cancelRequested is invalid',
  );
  assertCheckpoint(
    value.deadlineExpired === undefined ||
      typeof value.deadlineExpired === 'boolean',
    'deadlineExpired is invalid',
  );

  const invocations = [
    ...parseInvocations(value.invocations, workflowVersionId),
  ].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  assertCheckpoint(
    new Set(invocations.map(({ invocationKey }) => invocationKey)).size ===
      invocations.length,
    'invocation keys must be unique',
  );
  const joins = value.joins
    .map(parseJoin)
    .sort((left, right) => compareOrdinal(left.joinId, right.joinId));
  assertCheckpoint(
    new Set(joins.map(({ joinInvocationKey }) => joinInvocationKey)).size ===
      joins.length,
    'join invocation keys must be unique',
  );
  const loops = value.loops
    .map(parseLoop)
    .sort((left, right) =>
      compareOrdinal(left.controlInvocationKey, right.controlInvocationKey),
    );
  assertCheckpoint(
    new Set(loops.map(({ controlInvocationKey }) => controlInvocationKey))
      .size === loops.length,
    'loop control invocation keys must be unique',
  );
  assertCheckpoint(
    joins.every(({ joinId }) => !loops.some(({ loopId }) => loopId === joinId)),
    'a node cannot be both a join and a loop',
  );
  assertCheckpoint(
    value.readySet.every((item) => typeof item === 'string'),
    'readySet must contain strings',
  );
  assertCheckpoint(
    value.admittedInvocationKeys.every((item) => typeof item === 'string'),
    'admittedInvocationKeys must contain strings',
  );
  const readySet = sortedUnique(value.readySet, 'readySet');
  const reconstructed = invocations
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  assertCheckpoint(
    readySet.length === reconstructed.length &&
      readySet.every((key, index) => key === reconstructed[index]),
    'readySet disagrees with invocation state',
  );
  const invocationByKey = new Map(
    invocations.map((invocation) => [invocation.invocationKey, invocation]),
  );
  for (const join of joins) {
    const joinInvocation = invocationByKey.get(join.joinInvocationKey);
    assertCheckpoint(
      joinInvocation !== undefined,
      'join invocation is missing',
    );
    if (join.unsatisfiedReasonCode !== undefined)
      assertCheckpoint(
        joinInvocation.status === 'failed',
        'unsatisfied join invocation must be failed',
      );
    else if (join.selectedBranchIds !== undefined)
      assertCheckpoint(
        joinInvocation.status !== 'pending',
        'selected join invocation cannot be pending',
      );
    else
      assertCheckpoint(
        joinInvocation.status === 'pending' ||
          (value.cancelRequested && joinInvocation.status === 'canceled') ||
          (value.deadlineExpired === true &&
            joinInvocation.status === 'canceled'),
        'unsettled join invocation is inconsistent',
      );
  }
  for (const loop of loops) {
    const parent = invocationByKey.get(loop.controlInvocationKey);
    assertCheckpoint(parent !== undefined, 'loop parent invocation is missing');
    assertCheckpoint(
      loopParentStatusIsConsistent(
        loop,
        parent,
        value.cancelRequested,
        value.deadlineExpired === true,
      ),
      'loop parent invocation is inconsistent',
    );
  }
  const loopControlKeys = new Set(
    loops.map(({ controlInvocationKey }) => controlInvocationKey),
  );
  assertCheckpoint(
    invocations.every(
      ({ invocationKey: key, status, resumeAt, waitKind }) =>
        status !== 'waiting' ||
        (resumeAt !== undefined && waitKind !== undefined) ||
        loopControlKeys.has(key),
    ),
    'ordinary waiting invocation requires resumeAt',
  );

  const initialIterationBudget = value.initialIterationBudget;
  assertCheckpoint(
    initialIterationBudget === undefined ||
      (isInteger(initialIterationBudget) && initialIterationBudget >= 0),
    'initialIterationBudget is invalid',
  );
  assertCheckpoint(
    loops.length === 0 || initialIterationBudget !== undefined,
    'loop checkpoint requires initialIterationBudget',
  );
  if (initialIterationBudget !== undefined)
    assertCheckpoint(
      value.remainingIterationBudget +
        loops.reduce((total, loop) => total + loop.collectionSize, 0) ===
        initialIterationBudget,
      'iteration budget accounting is inconsistent',
    );

  return {
    schemaVersion: 2,
    engineVersion,
    workflowVersionId,
    revision: value.revision,
    runStatus: value.runStatus,
    nextEventSequence: value.nextEventSequence,
    admittedInvocationKeys: sortedUnique(
      value.admittedInvocationKeys,
      'admittedInvocationKeys',
    ),
    invocations,
    joins,
    loops,
    readySet,
    remainingIterationBudget: value.remainingIterationBudget,
    cancelRequested: value.cancelRequested,
    deadlineExpired: value.deadlineExpired ?? false,
    branchSelections: parseBranchSelections(
      value.branchSelections,
      invocations,
    ),
    ...(initialIterationBudget === undefined ? {} : { initialIterationBudget }),
  };
}
