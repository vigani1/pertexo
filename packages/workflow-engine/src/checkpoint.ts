import { types as nodeTypes } from 'node:util';

import { WorkflowEngineError } from './errors.js';
import { invocationKey } from './scheduling.js';
import {
  NODE_STATUSES,
  RUN_STATUSES,
  type BranchLedgerEntry,
  type InvocationState,
  type JoinState,
  type LoopState,
  type OutputReference,
  type WorkflowCheckpointV1,
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const WORKFLOW_CHECKPOINT_LIMITS_V1 = Object.freeze({
  bytes: 262_144,
  depth: 64,
  members: 10_000,
  arrayItems: 10_000,
});

function assertCheckpoint(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new WorkflowEngineError('checkpoint_invalid', message);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const ownNames = Object.getOwnPropertyNames(value);
  assertCheckpoint(
    ownNames.every((key) => allowed.has(key)) &&
      required.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          'value' in descriptor
        );
      }) &&
      optional.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor === undefined ||
          (descriptor.enumerable && 'value' in descriptor)
        );
      }),
    'checkpoint contains missing or unknown fields',
  );
}

function isNodeStatus(value: unknown): value is InvocationState['status'] {
  return (
    typeof value === 'string' &&
    NODE_STATUSES.some((candidate) => candidate === value)
  );
}

function isRunStatus(
  value: unknown,
): value is WorkflowCheckpointV1['runStatus'] {
  return (
    typeof value === 'string' &&
    RUN_STATUSES.some((candidate) => candidate === value)
  );
}

function isBranchDisposition(
  value: unknown,
): value is BranchLedgerEntry['disposition'] {
  return (
    typeof value === 'string' &&
    ['pending', 'arrived', 'skipped', 'missing', 'failed', 'canceled'].some(
      (candidate) => candidate === value,
    )
  );
}

function assertBoundedCheckpointJson(value: unknown): void {
  const addBytes = (current: number, added: number): number => {
    const next = current + added;
    assertCheckpoint(
      next <= WORKFLOW_CHECKPOINT_LIMITS_V1.bytes,
      'checkpoint exceeds maximum bytes',
    );
    return next;
  };
  const stringBytes = (input: string): number => {
    let bytes = 2;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      const escaped =
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x0c ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09;
      if (escaped) bytes = addBytes(bytes, 2);
      else if (code <= 0x1f) bytes = addBytes(bytes, 6);
      else if (code <= 0x7f) bytes = addBytes(bytes, 1);
      else if (code <= 0x7ff) bytes = addBytes(bytes, 2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes = addBytes(bytes, 4);
          index += 1;
        } else bytes = addBytes(bytes, 6);
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes = addBytes(bytes, 6);
      else bytes = addBytes(bytes, 3);
    }
    return bytes;
  };
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  const ancestors = new Set<object>();
  const exits = new Set<object>();
  let members = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const item = current.value;
    if (item === null) {
      bytes = addBytes(bytes, 4);
      continue;
    }
    if (typeof item === 'string') {
      bytes = addBytes(bytes, stringBytes(item));
      continue;
    }
    if (typeof item === 'boolean') {
      bytes = addBytes(bytes, item ? 4 : 5);
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      bytes = addBytes(bytes, Object.is(item, -0) ? 1 : String(item).length);
      continue;
    }
    assertCheckpoint(typeof item === 'object', 'checkpoint must contain JSON');
    assertCheckpoint(
      !nodeTypes.isProxy(item),
      'checkpoint must not contain proxy objects',
    );
    if (exits.has(item)) {
      exits.delete(item);
      ancestors.delete(item);
      continue;
    }
    assertCheckpoint(
      current.depth <= WORKFLOW_CHECKPOINT_LIMITS_V1.depth,
      'checkpoint exceeds maximum depth',
    );
    assertCheckpoint(
      !ancestors.has(item),
      'checkpoint must not contain cycles',
    );
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    assertCheckpoint(
      isArray || prototype === Object.prototype || prototype === null,
      'checkpoint must contain plain JSON objects',
    );
    if (isArray) {
      assertCheckpoint(
        item.length <= WORKFLOW_CHECKPOINT_LIMITS_V1.arrayItems,
        'checkpoint array is oversized',
      );
      bytes = addBytes(bytes, 2 + Math.max(0, item.length - 1));
    } else bytes = addBytes(bytes, 2);
    ancestors.add(item);
    exits.add(item);
    pending.push({ value: item, depth: current.depth });
    let enumerableCount = 0;
    for (const key in item) {
      assertCheckpoint(
        Object.hasOwn(item, key),
        'checkpoint must not contain inherited enumerable properties',
      );
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      assertCheckpoint(
        descriptor !== undefined &&
          descriptor.enumerable &&
          'value' in descriptor,
        'checkpoint must not contain accessors',
      );
      members += 1;
      assertCheckpoint(
        members <= WORKFLOW_CHECKPOINT_LIMITS_V1.members,
        'checkpoint exceeds maximum members',
      );
      if (isArray)
        assertCheckpoint(
          key === String(enumerableCount),
          'checkpoint array is sparse or has extra properties',
        );
      else {
        if (enumerableCount > 0) bytes = addBytes(bytes, 1);
        bytes = addBytes(bytes, stringBytes(key) + 1);
      }
      enumerableCount += 1;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    // JavaScript has no incremental own-name/symbol reflection. Perform it
    // only after length/member-bounded enumerable traversal, then discard the
    // arrays immediately after comparing hidden names and symbols.
    const ownNames = Object.getOwnPropertyNames(item);
    assertCheckpoint(
      ownNames.length <=
        WORKFLOW_CHECKPOINT_LIMITS_V1.members + (isArray ? 1 : 0),
      'checkpoint exceeds maximum own properties',
    );
    assertCheckpoint(
      Object.getOwnPropertySymbols(item).length === 0,
      'checkpoint must not contain symbol properties',
    );
    if (isArray)
      assertCheckpoint(
        enumerableCount === item.length &&
          ownNames.length === item.length + 1 &&
          ownNames.includes('length'),
        'checkpoint array is sparse or has hidden properties',
      );
    else
      assertCheckpoint(
        ownNames.length === enumerableCount,
        'checkpoint object has hidden properties',
      );
  }
}

function sortedUnique(
  values: readonly string[],
  label: string,
): readonly string[] {
  assertCheckpoint(
    values.every((value) => value.length > 0),
    `${label} contains an empty key`,
  );
  const sorted = [...values].sort();
  assertCheckpoint(
    new Set(sorted).size === sorted.length,
    `${label} contains duplicates`,
  );
  return sorted;
}

function parseOutputReference(value: unknown, label: string): OutputReference {
  assertCheckpoint(isRecord(value), `${label} must be an object`);
  assertExactKeys(value, ['kind', 'reference']);
  assertCheckpoint(
    value.kind === 'inline' || value.kind === 'artifact',
    `${label} kind is invalid`,
  );
  assertCheckpoint(
    typeof value.reference === 'string' && value.reference.length > 0,
    `${label} reference is required`,
  );
  return { kind: value.kind, reference: value.reference };
}

function parseInvocation(value: unknown): InvocationState {
  assertCheckpoint(isRecord(value), 'invocation must be an object');
  assertExactKeys(
    value,
    ['invocationKey', 'nodeId', 'status', 'attemptNumber'],
    ['resumeAt', 'output'],
  );
  assertCheckpoint(
    typeof value.invocationKey === 'string' && value.invocationKey.length > 0,
    'invocationKey is required',
  );
  assertCheckpoint(
    typeof value.nodeId === 'string' && value.nodeId.length > 0,
    'nodeId is required',
  );
  assertCheckpoint(isNodeStatus(value.status), 'invocation status is invalid');
  assertCheckpoint(
    isInteger(value.attemptNumber) && value.attemptNumber >= 0,
    'attemptNumber must be a non-negative integer',
  );
  if (value.resumeAt !== undefined) {
    assertCheckpoint(
      typeof value.resumeAt === 'string' &&
        Number.isFinite(Date.parse(value.resumeAt)),
      'resumeAt must be a valid timestamp',
    );
  }
  assertCheckpoint(
    value.status === 'waiting'
      ? value.resumeAt !== undefined
      : value.resumeAt === undefined,
    'resumeAt must exist only for a waiting invocation',
  );
  const output =
    value.output === undefined
      ? undefined
      : parseOutputReference(value.output, 'invocation output');
  return {
    invocationKey: value.invocationKey,
    nodeId: value.nodeId,
    status: value.status,
    attemptNumber: value.attemptNumber,
    ...(value.resumeAt === undefined ? {} : { resumeAt: value.resumeAt }),
    ...(output === undefined ? {} : { output }),
  };
}

function parseLedger(value: unknown): readonly BranchLedgerEntry[] {
  assertCheckpoint(Array.isArray(value), 'join ledger must be an array');
  const allowed: readonly BranchLedgerEntry['disposition'][] = [
    'pending',
    'arrived',
    'skipped',
    'missing',
    'failed',
    'canceled',
  ];
  const ledger = value.map((entry): BranchLedgerEntry => {
    assertCheckpoint(isRecord(entry), 'branch ledger entry must be an object');
    assertExactKeys(entry, ['branchId', 'disposition'], ['output']);
    assertCheckpoint(
      typeof entry.branchId === 'string' && entry.branchId.length > 0,
      'branchId is required',
    );
    assertCheckpoint(
      isBranchDisposition(entry.disposition) &&
        allowed.some((candidate) => candidate === entry.disposition),
      'branch disposition is invalid',
    );
    const output =
      entry.output === undefined
        ? undefined
        : parseOutputReference(entry.output, 'branch output');
    return {
      branchId: entry.branchId,
      disposition: entry.disposition,
      ...(output === undefined ? {} : { output }),
    };
  });
  return [...ledger].sort((left, right) =>
    left.branchId.localeCompare(right.branchId),
  );
}

function parseJoin(value: unknown): JoinState {
  assertCheckpoint(isRecord(value), 'join must be an object');
  assertExactKeys(
    value,
    ['joinId', 'policy', 'ledger'],
    ['selectedBranchIds', 'unsatisfiedReasonCode'],
  );
  assertCheckpoint(
    typeof value.joinId === 'string' && value.joinId.length > 0,
    'joinId is required',
  );
  assertCheckpoint(isRecord(value.policy), 'join policy is required');
  assertExactKeys(
    value.policy,
    ['kind'],
    value.policy.kind === 'count' ? ['count'] : [],
  );
  const kind = value.policy.kind;
  assertCheckpoint(
    kind === 'all' || kind === 'any' || kind === 'count',
    'join policy is invalid',
  );
  let count: number | undefined;
  if (kind === 'count') {
    assertCheckpoint(
      isInteger(value.policy.count) && value.policy.count > 0,
      'join count must be positive',
    );
    count = value.policy.count;
  }
  const policy: JoinState['policy'] =
    kind === 'count'
      ? { kind, count: count ?? 0 }
      : kind === 'any'
        ? { kind }
        : { kind };
  const ledger = parseLedger(value.ledger);
  assertCheckpoint(
    new Set(ledger.map(({ branchId }) => branchId)).size === ledger.length,
    'join branch IDs must be unique',
  );
  assertCheckpoint(ledger.length > 0, 'join must declare at least one branch');
  if (kind === 'count') {
    assertCheckpoint(
      policy.kind === 'count' && policy.count <= ledger.length,
      'join count exceeds declared branches',
    );
  }
  let selectedBranchIds: readonly string[] | undefined;
  let unsatisfiedReasonCode: JoinState['unsatisfiedReasonCode'];
  if (value.unsatisfiedReasonCode !== undefined) {
    assertCheckpoint(
      value.unsatisfiedReasonCode === 'branch_failed' ||
        value.unsatisfiedReasonCode === 'branch_canceled' ||
        value.unsatisfiedReasonCode === 'insufficient_arrivals',
      'join unsatisfied reason is invalid',
    );
    unsatisfiedReasonCode = value.unsatisfiedReasonCode;
  }
  assertCheckpoint(
    value.selectedBranchIds === undefined ||
      unsatisfiedReasonCode === undefined,
    'join cannot be both satisfied and unsatisfied',
  );
  if (value.selectedBranchIds !== undefined) {
    assertCheckpoint(
      Array.isArray(value.selectedBranchIds),
      'selectedBranchIds must be an array',
    );
    assertCheckpoint(
      value.selectedBranchIds.every((item) => typeof item === 'string'),
      'selectedBranchIds must contain strings',
    );
    selectedBranchIds = sortedUnique(
      value.selectedBranchIds,
      'selectedBranchIds',
    );
    assertCheckpoint(
      ledger.every(({ disposition }) => disposition !== 'pending'),
      'a selected join cannot contain pending branches',
    );
    const arrived = ledger
      .filter(({ disposition }) => disposition === 'arrived')
      .map(({ branchId }) => branchId);
    const required =
      kind === 'all'
        ? arrived.length
        : kind === 'any'
          ? 1
          : policy.kind === 'count'
            ? policy.count
            : 0;
    const satisfiable =
      kind === 'all'
        ? ledger.every(
            ({ disposition }) =>
              disposition !== 'failed' && disposition !== 'canceled',
          )
        : arrived.length >= required;
    const expected = satisfiable ? arrived.slice(0, required) : [];
    assertCheckpoint(
      satisfiable &&
        selectedBranchIds.length === expected.length &&
        selectedBranchIds.every(
          (branchId, index) => branchId === expected[index],
        ),
      'persisted join selection is inconsistent',
    );
  }
  if (unsatisfiedReasonCode !== undefined) {
    assertCheckpoint(
      ledger.every(({ disposition }) => disposition !== 'pending'),
      'an unsatisfied join cannot contain pending branches',
    );
    const arrivedCount = ledger.filter(
      ({ disposition }) => disposition === 'arrived',
    ).length;
    const expectedReason =
      kind === 'all' &&
      ledger.some(({ disposition }) => disposition === 'failed')
        ? 'branch_failed'
        : kind === 'all' &&
            ledger.some(({ disposition }) => disposition === 'canceled')
          ? 'branch_canceled'
          : kind !== 'all' &&
              arrivedCount <
                (kind === 'any'
                  ? 1
                  : policy.kind === 'count'
                    ? policy.count
                    : 0)
            ? 'insufficient_arrivals'
            : undefined;
    assertCheckpoint(
      unsatisfiedReasonCode === expectedReason,
      'persisted join failure is inconsistent',
    );
  }
  return {
    joinId: value.joinId,
    policy,
    ledger,
    ...(selectedBranchIds === undefined ? {} : { selectedBranchIds }),
    ...(unsatisfiedReasonCode === undefined ? {} : { unsatisfiedReasonCode }),
  };
}

function parseLoop(value: unknown): LoopState {
  assertCheckpoint(isRecord(value), 'loop must be an object');
  assertExactKeys(value, [
    'loopId',
    'collection',
    'collectionChecksum',
    'collectionSize',
    'maxConcurrency',
    'maxIterations',
    'nextOrdinal',
    'activeOrdinals',
    'terminalOrdinals',
  ]);
  assertCheckpoint(
    typeof value.loopId === 'string' && value.loopId.length > 0,
    'loopId is required',
  );
  const collection = parseOutputReference(value.collection, 'loop collection');
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
    loopId: value.loopId,
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

function parseCheckpointBoundary(value: unknown): WorkflowCheckpointV1 {
  assertBoundedCheckpointJson(value);
  if (isRecord(value) && value.schemaVersion !== 1) {
    throw new WorkflowEngineError(
      'checkpoint_unsupported',
      `Unsupported checkpoint schema version: ${String(value.schemaVersion)}`,
    );
  }
  assertCheckpoint(isRecord(value), 'checkpoint must be an object');
  assertExactKeys(value, [
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
  ]);
  assertCheckpoint(
    value.schemaVersion === 1,
    'checkpoint schemaVersion must be 1',
  );
  assertCheckpoint(
    typeof value.engineVersion === 'string' && value.engineVersion.length > 0,
    'engineVersion is required',
  );
  assertCheckpoint(
    typeof value.workflowVersionId === 'string' &&
      value.workflowVersionId.length > 0,
    'workflowVersionId is required',
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

  const invocations = value.invocations
    .map(parseInvocation)
    .sort((left, right) =>
      left.invocationKey.localeCompare(right.invocationKey),
    );
  assertCheckpoint(
    new Set(invocations.map(({ invocationKey }) => invocationKey)).size ===
      invocations.length,
    'invocation keys must be unique',
  );
  const joins = value.joins
    .map(parseJoin)
    .sort((left, right) => left.joinId.localeCompare(right.joinId));
  assertCheckpoint(
    new Set(joins.map(({ joinId }) => joinId)).size === joins.length,
    'join IDs must be unique',
  );
  const loops = value.loops
    .map(parseLoop)
    .sort((left, right) => left.loopId.localeCompare(right.loopId));
  assertCheckpoint(
    new Set(loops.map(({ loopId }) => loopId)).size === loops.length,
    'loop IDs must be unique',
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
      invocationKey({
        workflowVersionId: value.workflowVersionId,
        nodeId: join.joinId,
      }),
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
          (value.cancelRequested && joinInvocation.status === 'canceled'),
        'unsettled join invocation is inconsistent',
      );
  }
  for (const loop of loops) {
    const parent = invocationByKey.get(
      invocationKey({
        workflowVersionId: value.workflowVersionId,
        nodeId: loop.loopId,
      }),
    );
    assertCheckpoint(parent !== undefined, 'loop parent invocation is missing');
    const loopComplete =
      loop.nextOrdinal === loop.collectionSize &&
      loop.activeOrdinals.length === 0;
    assertCheckpoint(
      loopComplete
        ? parent.status === 'succeeded' ||
            (value.cancelRequested && parent.status === 'canceled')
        : parent.status === 'pending' ||
            (value.cancelRequested && parent.status === 'canceled'),
      'loop parent invocation is inconsistent',
    );
    for (const ordinal of loop.activeOrdinals) {
      const iteration = invocationByKey.get(
        invocationKey({
          workflowVersionId: value.workflowVersionId,
          nodeId: loop.loopId,
          iterationPath: [{ loopNodeId: loop.loopId, ordinal }],
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
          workflowVersionId: value.workflowVersionId,
          nodeId: loop.loopId,
          iterationPath: [{ loopNodeId: loop.loopId, ordinal }],
        }),
      );
      assertCheckpoint(
        iteration !== undefined &&
          [
            'succeeded',
            'failed',
            'canceled',
            'timed_out',
            'outcome_unknown',
          ].includes(iteration.status),
        'terminal loop invocation is inconsistent',
      );
    }
  }

  return {
    schemaVersion: 1,
    engineVersion: value.engineVersion,
    workflowVersionId: value.workflowVersionId,
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
  };
}

export function parseCheckpoint(value: unknown): WorkflowCheckpointV1 {
  try {
    return parseCheckpointBoundary(value);
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      error instanceof Error ? error.message : 'checkpoint parsing failed',
    );
  }
}

export function reconstructReadySet(
  checkpoint: WorkflowCheckpointV1,
): readonly string[] {
  return checkpoint.invocations
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey)
    .sort();
}

export function createCheckpoint(input: {
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly iterationBudget: number;
  readonly nextEventSequence?: number;
}): WorkflowCheckpointV1 {
  assertCheckpoint(
    Number.isSafeInteger(input.iterationBudget) && input.iterationBudget >= 0,
    'iterationBudget is invalid',
  );
  assertCheckpoint(
    input.nextEventSequence === undefined ||
      (Number.isSafeInteger(input.nextEventSequence) &&
        input.nextEventSequence > 0),
    'nextEventSequence is invalid',
  );
  return {
    schemaVersion: 1,
    engineVersion: input.engineVersion,
    workflowVersionId: input.workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: input.nextEventSequence ?? 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: input.iterationBudget,
    cancelRequested: false,
  };
}
