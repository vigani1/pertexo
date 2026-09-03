import type { LoopState } from './types.js';
import { invocationKey } from './scheduling.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  parseOutputReference,
  sortedUnique,
} from './checkpoint-shared.js';

export function parseLoop(
  value: unknown,
  workflowVersionId: string,
): LoopState {
  assertCheckpoint(isRecord(value), 'loop must be an object');
  assertExactKeys(
    value,
    [
      'loopId',
      'collection',
      'collectionChecksum',
      'collectionSize',
      'maxConcurrency',
      'maxIterations',
      'nextOrdinal',
      'activeOrdinals',
      'terminalOrdinals',
    ],
    [
      'controlInvocationKey',
      'branchPath',
      'iterationPath',
      'bodyRootNodeIds',
      'bodySinkNodeId',
      'terminalStatus',
    ],
  );
  assertCheckpoint(
    typeof value.loopId === 'string' && value.loopId.length > 0,
    'loopId is required',
  );
  const collection = parseOutputReference(value.collection, 'loop collection');
  assertCheckpoint(
    value.controlInvocationKey === undefined ||
      (typeof value.controlInvocationKey === 'string' &&
        value.controlInvocationKey.length > 0),
    'loop control key is invalid',
  );
  const controlInvocationKey =
    value.controlInvocationKey ??
    invocationKey({ workflowVersionId, nodeId: value.loopId });
  assertCheckpoint(
    controlInvocationKey.length > 0,
    'loop control key is required',
  );
  assertCheckpoint(
    value.branchPath === undefined || Array.isArray(value.branchPath),
    'loop branch scope must be an array',
  );
  const branchPath = Array.isArray(value.branchPath)
    ? value.branchPath.map((part) => {
        assertCheckpoint(isRecord(part), 'loop branch scope must be an object');
        assertExactKeys(part, ['nodeId', 'outputPort']);
        assertCheckpoint(
          typeof part.nodeId === 'string' &&
            part.nodeId.length > 0 &&
            typeof part.outputPort === 'string' &&
            part.outputPort.length > 0,
          'loop branch scope is invalid',
        );
        return { nodeId: part.nodeId, outputPort: part.outputPort };
      })
    : [];
  assertCheckpoint(
    value.iterationPath === undefined || Array.isArray(value.iterationPath),
    'loop iteration scope must be an array',
  );
  const iterationPath = Array.isArray(value.iterationPath)
    ? value.iterationPath.map((part) => {
        assertCheckpoint(
          isRecord(part),
          'loop iteration scope must be an object',
        );
        assertExactKeys(part, ['loopNodeId', 'ordinal']);
        assertCheckpoint(
          typeof part.loopNodeId === 'string' &&
            part.loopNodeId.length > 0 &&
            isInteger(part.ordinal) &&
            part.ordinal >= 0,
          'loop iteration scope is invalid',
        );
        return { loopNodeId: part.loopNodeId, ordinal: part.ordinal };
      })
    : [];
  assertCheckpoint(
    value.bodyRootNodeIds === undefined || Array.isArray(value.bodyRootNodeIds),
    'loop body roots must be an array',
  );
  const bodyRootNodeIds = Array.isArray(value.bodyRootNodeIds)
    ? sortedUnique(
        value.bodyRootNodeIds.filter(
          (item): item is string => typeof item === 'string',
        ),
        'loop body roots',
      )
    : [value.loopId];
  const rawBodyRootCount = Array.isArray(value.bodyRootNodeIds)
    ? value.bodyRootNodeIds.length
    : undefined;
  assertCheckpoint(
    bodyRootNodeIds.length > 0 &&
      (rawBodyRootCount === undefined ||
        bodyRootNodeIds.length === rawBodyRootCount),
    'loop body roots are invalid',
  );
  assertCheckpoint(
    value.bodySinkNodeId === undefined ||
      (typeof value.bodySinkNodeId === 'string' &&
        value.bodySinkNodeId.length > 0),
    'loop body sink is invalid',
  );
  const bodySinkNodeId = value.bodySinkNodeId ?? value.loopId;
  assertCheckpoint(bodySinkNodeId.length > 0, 'loop body sink is invalid');
  const terminalStatus = value.terminalStatus;
  assertCheckpoint(
    terminalStatus === undefined ||
      terminalStatus === 'failed' ||
      terminalStatus === 'canceled' ||
      terminalStatus === 'timed_out' ||
      terminalStatus === 'outcome_unknown',
    'loop terminal status is invalid',
  );
  assertCheckpoint(
    typeof value.collectionChecksum === 'string' &&
      value.collectionChecksum.length > 0,
    'collectionChecksum is required',
  );
  for (const field of [
    'collectionSize',
    'maxConcurrency',
    'maxIterations',
    'nextOrdinal',
  ] as const) {
    assertCheckpoint(
      isInteger(value[field]) && value[field] >= 0,
      `${field} is invalid`,
    );
  }
  assertCheckpoint(
    Array.isArray(value.activeOrdinals),
    'activeOrdinals must be an array',
  );
  assertCheckpoint(
    Array.isArray(value.terminalOrdinals),
    'terminalOrdinals must be an array',
  );
  const collectionSize = value.collectionSize;
  const maxConcurrency = value.maxConcurrency;
  const maxIterations = value.maxIterations;
  const nextOrdinal = value.nextOrdinal;
  assertCheckpoint(isInteger(collectionSize), 'collectionSize is invalid');
  assertCheckpoint(isInteger(maxConcurrency), 'maxConcurrency is invalid');
  assertCheckpoint(isInteger(maxIterations), 'maxIterations is invalid');
  assertCheckpoint(isInteger(nextOrdinal), 'nextOrdinal is invalid');
  assertCheckpoint(maxConcurrency > 0, 'maxConcurrency must be positive');
  assertCheckpoint(maxIterations > 0, 'maxIterations must be positive');
  assertCheckpoint(
    maxConcurrency <= maxIterations,
    'loop concurrency exceeds iterations',
  );
  assertCheckpoint(
    collectionSize <= maxIterations,
    'loop collection exceeds iterations',
  );
  assertCheckpoint(
    nextOrdinal <= collectionSize,
    'loop cursor exceeds collection',
  );
  assertCheckpoint(
    value.activeOrdinals.every(isInteger),
    'activeOrdinals must contain integers',
  );
  assertCheckpoint(
    value.terminalOrdinals.every(isInteger),
    'terminalOrdinals must contain integers',
  );
  const activeOrdinals = [...value.activeOrdinals].sort(
    (left, right) => left - right,
  );
  const terminalOrdinals = [...value.terminalOrdinals].sort(
    (left, right) => left - right,
  );
  const ordinals = [...activeOrdinals, ...terminalOrdinals];
  assertCheckpoint(
    ordinals.every(
      (ordinal) =>
        isInteger(ordinal) && ordinal >= 0 && ordinal < collectionSize,
    ),
    'loop ordinal is outside the collection',
  );
  assertCheckpoint(
    new Set(ordinals).size === ordinals.length,
    'loop ordinals overlap',
  );
  assertCheckpoint(
    activeOrdinals.length <= maxConcurrency,
    'active loop ordinals exceed concurrency',
  );
  const admitted = [...ordinals].sort((left, right) => left - right);
  assertCheckpoint(
    admitted.length === nextOrdinal &&
      admitted.every((ordinal, index) => ordinal === index),
    'loop cursor has an unrecorded ordinal',
  );
  return {
    controlInvocationKey,
    loopId: value.loopId,
    branchPath,
    iterationPath,
    bodyRootNodeIds,
    bodySinkNodeId,
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    collection,
    collectionChecksum: value.collectionChecksum,
    collectionSize,
    maxConcurrency,
    maxIterations,
    nextOrdinal,
    activeOrdinals,
    terminalOrdinals,
  };
}
