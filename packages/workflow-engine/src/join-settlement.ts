import { WorkflowEngineError } from './workflow-engine.errors.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import { sameOutputReference } from './output-reference.js';
import type {
  BranchLedgerEntry,
  JoinPolicy,
  JoinState,
} from './workflow-execution.js';

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

export function settleJoin(
  join: Pick<JoinState, 'policy' | 'ledger'>,
): JoinDecision {
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
  const invalidCountPolicy =
    !Number.isSafeInteger(policy.count) ||
    policy.count <= 0 ||
    policy.count > declaredBranches;
  if (invalidCountPolicy) {
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
      sameOutputReference(existing.output, update.output)
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
