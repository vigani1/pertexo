import type { WorkflowCheckpointV1 } from './types.js';
import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import { invocationKey } from './scheduling.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  isRunStatus,
  parseInvocation,
  sortedUnique,
} from './checkpoint-shared.js';
import {
  assertPersistedEngineVersion,
  assertPersistedWorkflowVersionId,
} from './checkpoint-identity.js';
import { parseJoin } from './checkpoint-v1-join.js';
import { parseLoop } from './checkpoint-v1-loop.js';

export function parseCheckpointV1Boundary(
  value: unknown,
): WorkflowCheckpointV1 {
  if (isRecord(value) && value.schemaVersion !== 1) {
    throw new WorkflowEngineError(
      'checkpoint_unsupported',
      `Unsupported checkpoint schema version: ${String(value.schemaVersion)}`,
    );
  }
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
    ],
    ['deadlineExpired'],
  );
  assertCheckpoint(
    value.schemaVersion === 1,
    'checkpoint schemaVersion must be 1',
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

  const invocations = value.invocations
    .map(parseInvocation)
    .sort((left, right) =>
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
    .map((loop) => parseLoop(loop, workflowVersionId))
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
    const joinInvocation = invocationByKey.get(
      join.joinInvocationKey === join.joinId
        ? invocationKey({
            workflowVersionId,
            nodeId: join.joinId,
          })
        : (join.joinInvocationKey ??
            invocationKey({
              workflowVersionId,
              nodeId: join.joinId,
            })),
    );
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
    const loopComplete =
      loop.nextOrdinal === loop.collectionSize &&
      loop.activeOrdinals.length === 0;
    assertCheckpoint(
      loop.terminalStatus !== undefined
        ? parent.status === loop.terminalStatus
        : loopComplete
          ? parent.status === 'succeeded' ||
            (value.cancelRequested && parent.status === 'canceled') ||
            (value.deadlineExpired === true && parent.status === 'timed_out')
          : parent.status === 'pending' ||
            parent.status === 'waiting' ||
            (value.cancelRequested && parent.status === 'canceled') ||
            (value.deadlineExpired === true && parent.status === 'timed_out'),
      'loop parent invocation is inconsistent',
    );
    const syntheticLegacyLoop =
      loop.bodyRootNodeIds.length === 1 &&
      loop.bodyRootNodeIds[0] === loop.loopId &&
      loop.bodySinkNodeId === loop.loopId;
    if (!syntheticLegacyLoop) continue;
    for (const ordinal of loop.activeOrdinals) {
      const iteration = invocationByKey.get(
        invocationKey({
          workflowVersionId,
          nodeId: loop.loopId,
          branchPath: loop.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          iterationPath: [
            ...loop.iterationPath,
            { loopNodeId: loop.loopId, ordinal },
          ],
        }),
      );
      assertCheckpoint(
        iteration !== undefined &&
          ['ready', 'running', 'waiting'].includes(iteration.status),
        'active loop invocation is inconsistent',
      );
    }
    for (const ordinal of loop.terminalOrdinals) {
      const iteration = invocationByKey.get(
        invocationKey({
          workflowVersionId,
          nodeId: loop.loopId,
          branchPath: loop.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          iterationPath: [
            ...loop.iterationPath,
            { loopNodeId: loop.loopId, ordinal },
          ],
        }),
      );
      assertCheckpoint(
        iteration !== undefined &&
          [
            'succeeded',
            'skipped',
            'failed',
            'canceled',
            'timed_out',
            'outcome_unknown',
          ].includes(iteration.status),
        'terminal loop invocation is inconsistent',
      );
    }
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

  return {
    schemaVersion: 1,
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
  };
}
