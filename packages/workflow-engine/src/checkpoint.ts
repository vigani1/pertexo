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

function assertCheckpoint(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new WorkflowEngineError('checkpoint_invalid', message);
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
  assertCheckpoint(
    typeof value.invocationKey === 'string' && value.invocationKey.length > 0,
    'invocationKey is required',
  );
  assertCheckpoint(
    typeof value.nodeId === 'string' && value.nodeId.length > 0,
    'nodeId is required',
  );
  assertCheckpoint(
    typeof value.status === 'string' &&
      NODE_STATUSES.includes(value.status as never),
    'invocation status is invalid',
  );
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
    status: value.status as InvocationState['status'],
    attemptNumber: value.attemptNumber,
    ...(value.resumeAt === undefined ? {} : { resumeAt: value.resumeAt }),
    ...(output === undefined ? {} : { output }),
  };
}

function parseLedger(value: unknown): readonly BranchLedgerEntry[] {
  assertCheckpoint(Array.isArray(value), 'join ledger must be an array');
  const ledger = value as unknown as BranchLedgerEntry[];
  const allowed = [
    'pending',
    'arrived',
    'skipped',
    'missing',
    'failed',
    'canceled',
  ];
  for (const entry of ledger) {
    assertCheckpoint(isRecord(entry), 'branch ledger entry must be an object');
    assertCheckpoint(
      typeof entry.branchId === 'string' && entry.branchId.length > 0,
      'branchId is required',
    );
    assertCheckpoint(
      allowed.includes(entry.disposition),
      'branch disposition is invalid',
    );
    if (entry.output !== undefined)
      parseOutputReference(entry.output, 'branch output');
  }
  return [...ledger].sort((left, right) =>
    left.branchId.localeCompare(right.branchId),
  );
}

function parseJoin(value: unknown): JoinState {
  assertCheckpoint(isRecord(value), 'join must be an object');
  assertCheckpoint(
    typeof value.joinId === 'string' && value.joinId.length > 0,
    'joinId is required',
  );
  assertCheckpoint(isRecord(value.policy), 'join policy is required');
  const kind = value.policy.kind;
  assertCheckpoint(
    kind === 'all' || kind === 'any' || kind === 'count',
    'join policy is invalid',
  );
  if (kind === 'count') {
    assertCheckpoint(
      isInteger(value.policy.count) && value.policy.count > 0,
      'join count must be positive',
    );
  }
  const ledger = parseLedger(value.ledger);
  assertCheckpoint(
    new Set(ledger.map(({ branchId }) => branchId)).size === ledger.length,
    'join branch IDs must be unique',
  );
  assertCheckpoint(ledger.length > 0, 'join must declare at least one branch');
  if (kind === 'count') {
    assertCheckpoint(
      (value.policy.count as number) <= ledger.length,
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
    selectedBranchIds = sortedUnique(
      value.selectedBranchIds as string[],
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
          : (value.policy.count as number);
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
                (kind === 'any' ? 1 : (value.policy.count as number))
            ? 'insufficient_arrivals'
            : undefined;
    assertCheckpoint(
      unsatisfiedReasonCode === expectedReason,
      'persisted join failure is inconsistent',
    );
  }
  return {
    joinId: value.joinId,
    policy: value.policy as unknown as JoinState['policy'],
    ledger,
    ...(selectedBranchIds === undefined ? {} : { selectedBranchIds }),
    ...(unsatisfiedReasonCode === undefined ? {} : { unsatisfiedReasonCode }),
  };
}

function parseLoop(value: unknown): LoopState {
  assertCheckpoint(isRecord(value), 'loop must be an object');
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
  const collectionSize = value.collectionSize as number;
  const maxConcurrency = value.maxConcurrency as number;
  const maxIterations = value.maxIterations as number;
  const nextOrdinal = value.nextOrdinal as number;
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
  const activeOrdinals = [...(value.activeOrdinals as number[])].sort(
    (left, right) => left - right,
  );
  const terminalOrdinals = [...(value.terminalOrdinals as number[])].sort(
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

export function parseCheckpoint(value: unknown): WorkflowCheckpointV1 {
  if (isRecord(value) && value.schemaVersion !== 1) {
    throw new WorkflowEngineError(
      'checkpoint_unsupported',
      `Unsupported checkpoint schema version: ${String(value.schemaVersion)}`,
    );
  }
  assertCheckpoint(isRecord(value), 'checkpoint must be an object');
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
  assertCheckpoint(
    typeof value.runStatus === 'string' &&
      RUN_STATUSES.includes(value.runStatus as never),
    'runStatus is invalid',
  );
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
  const readySet = sortedUnique(value.readySet as string[], 'readySet');
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
    runStatus: value.runStatus as WorkflowCheckpointV1['runStatus'],
    nextEventSequence: value.nextEventSequence,
    admittedInvocationKeys: sortedUnique(
      value.admittedInvocationKeys as string[],
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
