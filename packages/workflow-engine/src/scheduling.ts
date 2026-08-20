import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import type {
  BranchLedgerEntry,
  JoinPolicy,
  JoinState,
  LoopState,
  OutputReference,
} from './types.js';

const terminalDispositions = new Set([
  'arrived',
  'skipped',
  'missing',
  'failed',
  'canceled',
]);

export type JoinDecision =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'satisfied';
      readonly selectedBranchIds: readonly string[];
      readonly ledger: readonly BranchLedgerEntry[];
    }
  | {
      readonly kind: 'unsatisfied';
      readonly reasonCode:
        'branch_failed' | 'branch_canceled' | 'insufficient_arrivals';
      readonly ledger: readonly BranchLedgerEntry[];
    };

export function settleJoin(join: JoinState): JoinDecision {
  const ledger = [...join.ledger].sort((left, right) =>
    compareOrdinal(left.branchId, right.branchId),
  );
  if (
    new Set(ledger.map(({ branchId }) => branchId)).size !== ledger.length ||
    ledger.length === 0
  ) {
    throw new WorkflowEngineError(
      'join_invalid',
      'a join requires unique declared branches',
    );
  }
  if (ledger.some(({ disposition }) => !terminalDispositions.has(disposition)))
    return { kind: 'waiting' };

  const arrived = ledger.filter(({ disposition }) => disposition === 'arrived');
  const required = requiredArrivals(join.policy, ledger.length);
  if (join.policy.kind === 'all') {
    if (ledger.some(({ disposition }) => disposition === 'failed')) {
      return { kind: 'unsatisfied', reasonCode: 'branch_failed', ledger };
    }
    if (ledger.some(({ disposition }) => disposition === 'canceled')) {
      return { kind: 'unsatisfied', reasonCode: 'branch_canceled', ledger };
    }
  }
  if (arrived.length < required) {
    return { kind: 'unsatisfied', reasonCode: 'insufficient_arrivals', ledger };
  }
  return {
    kind: 'satisfied',
    selectedBranchIds: arrived
      .slice(0, join.policy.kind === 'all' ? arrived.length : required)
      .map(({ branchId }) => branchId),
    ledger,
  };
}

function requiredArrivals(
  policy: JoinPolicy,
  declaredBranches: number,
): number {
  if (policy.kind === 'all') return 0;
  if (policy.kind === 'any') return 1;
  if (
    !Number.isSafeInteger(policy.count) ||
    policy.count <= 0 ||
    policy.count > declaredBranches
  ) {
    throw new WorkflowEngineError(
      'join_invalid',
      'count join exceeds declared branches',
    );
  }
  return policy.count;
}

export function recordBranchDisposition(
  ledger: readonly BranchLedgerEntry[],
  update: BranchLedgerEntry,
): readonly BranchLedgerEntry[] {
  const existing = ledger.find(({ branchId }) => branchId === update.branchId);
  if (existing === undefined) {
    throw new WorkflowEngineError(
      'join_invalid',
      `branch ${update.branchId} is not declared`,
    );
  }
  if (existing.disposition !== 'pending') {
    if (
      existing.disposition === update.disposition &&
      existing.output?.kind === update.output?.kind &&
      existing.output?.reference === update.output?.reference
    ) {
      return [...ledger].sort((left, right) =>
        compareOrdinal(left.branchId, right.branchId),
      );
    }
    throw new WorkflowEngineError(
      'join_invalid',
      `branch ${update.branchId} already has a terminal disposition`,
    );
  }
  return ledger
    .map((entry) => (entry.branchId === update.branchId ? update : entry))
    .sort((left, right) => compareOrdinal(left.branchId, right.branchId));
}

export interface LoopAdmission {
  readonly loop: LoopState;
  readonly admittedOrdinals: readonly number[];
  readonly remainingIterationBudget: number;
}

export function createLoopState(input: {
  readonly loopId: string;
  readonly collection: OutputReference;
  readonly collectionChecksum: string;
  readonly collectionSize: number;
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly remainingIterationBudget: number;
}): LoopState {
  if (!Number.isSafeInteger(input.collectionSize) || input.collectionSize < 0) {
    throw new WorkflowEngineError(
      'loop_state_invalid',
      'collection size must be a non-negative integer',
    );
  }
  for (const value of [input.maxIterations, input.maxConcurrency]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkflowEngineError(
        'loop_state_invalid',
        'loop bounds must be positive integers',
      );
    }
  }
  if (
    input.maxConcurrency > input.maxIterations ||
    input.collectionSize > input.maxIterations ||
    input.collectionSize > input.remainingIterationBudget
  ) {
    throw new WorkflowEngineError(
      'loop_limit_exceeded',
      'collection exceeds pinned loop limits',
    );
  }
  return {
    loopId: input.loopId,
    collection: input.collection,
    collectionChecksum: input.collectionChecksum,
    collectionSize: input.collectionSize,
    maxConcurrency: input.maxConcurrency,
    maxIterations: input.maxIterations,
    nextOrdinal: 0,
    activeOrdinals: [],
    terminalOrdinals: [],
  };
}

export function admitLoopIterations(
  loop: LoopState,
  remainingIterationBudget: number,
): LoopAdmission {
  const active = [...loop.activeOrdinals].sort((a, b) => a - b);
  const terminal = [...loop.terminalOrdinals].sort((a, b) => a - b);
  const all = [...active, ...terminal];
  if (
    new Set(all).size !== all.length ||
    all.some((ordinal) => ordinal < 0 || ordinal >= loop.collectionSize)
  ) {
    throw new WorkflowEngineError(
      'loop_state_invalid',
      'loop ordinals are inconsistent',
    );
  }
  const capacity = Math.max(0, loop.maxConcurrency - active.length);
  const available = Math.min(
    capacity,
    loop.collectionSize - loop.nextOrdinal,
    remainingIterationBudget,
  );
  const admittedOrdinals = Array.from(
    { length: available },
    (_, offset) => loop.nextOrdinal + offset,
  );
  return {
    loop: {
      ...loop,
      activeOrdinals: [...active, ...admittedOrdinals],
      terminalOrdinals: terminal,
      nextOrdinal: loop.nextOrdinal + admittedOrdinals.length,
    },
    admittedOrdinals,
    remainingIterationBudget:
      remainingIterationBudget - admittedOrdinals.length,
  };
}

export function completeLoopIteration(
  loop: LoopState,
  ordinal: number,
): LoopState {
  if (!loop.activeOrdinals.includes(ordinal)) {
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `iteration ${String(ordinal)} is not active`,
    );
  }
  return {
    ...loop,
    activeOrdinals: loop.activeOrdinals
      .filter((current) => current !== ordinal)
      .sort((a, b) => a - b),
    terminalOrdinals: [...loop.terminalOrdinals, ordinal].sort((a, b) => a - b),
  };
}

export function invocationKey(input: {
  readonly workflowVersionId: string;
  readonly nodeId: string;
  readonly branchPath?: readonly string[];
  readonly iterationPath?: readonly {
    readonly loopNodeId: string;
    readonly ordinal: number;
  }[];
}): string {
  const branches = [...(input.branchPath ?? [])].join('/');
  const iterations = (input.iterationPath ?? [])
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  return `${encodeURIComponent(input.workflowVersionId)}|${encodeURIComponent(input.nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
}
