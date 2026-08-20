import { WorkflowEngineError } from './errors.js';
import {
  NODE_STATUSES,
  RUN_STATUSES,
  type BranchLedgerEntry,
  type InvocationState,
  type JoinState,
  type LoopState,
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

function parseInvocation(value: unknown): InvocationState {
  assertCheckpoint(isRecord(value), 'invocation must be an object');
  assertCheckpoint(
    typeof value.invocationKey === 'string',
    'invocationKey is required',
  );
  assertCheckpoint(typeof value.nodeId === 'string', 'nodeId is required');
  assertCheckpoint(
    typeof value.status === 'string' &&
      NODE_STATUSES.includes(value.status as never),
    'invocation status is invalid',
  );
  assertCheckpoint(
    isInteger(value.attemptNumber) && value.attemptNumber >= 0,
    'attemptNumber must be a non-negative integer',
  );
  return value as unknown as InvocationState;
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
      typeof entry.branchId === 'string',
      'branchId is required',
    );
    assertCheckpoint(
      allowed.includes(entry.disposition),
      'branch disposition is invalid',
    );
  }
  return [...ledger].sort((left, right) =>
    left.branchId.localeCompare(right.branchId),
  );
}

function parseJoin(value: unknown): JoinState {
  assertCheckpoint(isRecord(value), 'join must be an object');
  assertCheckpoint(typeof value.joinId === 'string', 'joinId is required');
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
  return { ...(value as unknown as JoinState), ledger };
}

function parseLoop(value: unknown): LoopState {
  assertCheckpoint(isRecord(value), 'loop must be an object');
  assertCheckpoint(typeof value.loopId === 'string', 'loopId is required');
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
  const ordinals = [
    ...(value.activeOrdinals as number[]),
    ...(value.terminalOrdinals as number[]),
  ];
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
  return value as unknown as LoopState;
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
    typeof value.engineVersion === 'string',
    'engineVersion is required',
  );
  assertCheckpoint(
    typeof value.workflowVersionId === 'string',
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
  const loops = value.loops
    .map(parseLoop)
    .sort((left, right) => left.loopId.localeCompare(right.loopId));
  const readySet = sortedUnique(value.readySet as string[], 'readySet');
  const reconstructed = invocations
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  assertCheckpoint(
    readySet.length === reconstructed.length &&
      readySet.every((key, index) => key === reconstructed[index]),
    'readySet disagrees with invocation state',
  );

  return {
    ...(value as unknown as WorkflowCheckpointV1),
    admittedInvocationKeys: sortedUnique(
      value.admittedInvocationKeys as string[],
      'admittedInvocationKeys',
    ),
    invocations,
    joins,
    loops,
    readySet,
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
  assertCheckpoint(input.iterationBudget >= 0, 'iterationBudget is invalid');
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
