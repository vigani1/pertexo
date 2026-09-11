import type { JoinState } from './types.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  parseLedger,
  parseBranchPath,
  parseIterationPath,
  sortedUnique,
} from './checkpoint-shared.js';

type JoinPolicy = JoinState['policy'];
type JoinLedger = JoinState['ledger'];

function requiredJoinArrivals(
  policy: JoinPolicy,
  arrivedCount: number,
): number {
  if (policy.kind === 'all') return arrivedCount;
  if (policy.kind === 'any') return 1;
  return policy.count;
}

function joinSelectionIsSatisfiable(
  policy: JoinPolicy,
  ledger: JoinLedger,
  arrivedCount: number,
): boolean {
  if (policy.kind !== 'all')
    return arrivedCount >= requiredJoinArrivals(policy, arrivedCount);
  return ledger.every(
    ({ disposition }) => disposition !== 'failed' && disposition !== 'canceled',
  );
}

function expectedUnsatisfiedReason(
  policy: JoinPolicy,
  ledger: JoinLedger,
  arrivedCount: number,
): JoinState['unsatisfiedReasonCode'] {
  if (policy.kind === 'all') {
    if (ledger.some(({ disposition }) => disposition === 'failed'))
      return 'branch_failed';
    if (ledger.some(({ disposition }) => disposition === 'canceled'))
      return 'branch_canceled';
    return undefined;
  }
  return arrivedCount < requiredJoinArrivals(policy, arrivedCount)
    ? 'insufficient_arrivals'
    : undefined;
}

export function parseJoin(value: unknown): JoinState {
  assertCheckpoint(isRecord(value), 'join must be an object');
  assertExactKeys(
    value,
    ['joinId', 'policy', 'ledger'],
    [
      'selectedBranchIds',
      'unsatisfiedReasonCode',
      'joinInvocationKey',
      'branchPath',
      'iterationPath',
    ],
  );
  assertCheckpoint(
    typeof value.joinId === 'string' && value.joinId.length > 0,
    'joinId is required',
  );
  assertCheckpoint(
    value.joinInvocationKey === undefined ||
      (typeof value.joinInvocationKey === 'string' &&
        value.joinInvocationKey.length > 0),
    'join invocation key is invalid',
  );
  const joinInvocationKey = value.joinInvocationKey ?? value.joinId;
  const branchPath = parseBranchPath(value.branchPath, 'join');
  const iterationPath = parseIterationPath(value.iterationPath, 'join');
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
    kind === 'count' ? { kind, count: count ?? 0 } : { kind };
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
    const required = requiredJoinArrivals(policy, arrived.length);
    const satisfiable = joinSelectionIsSatisfiable(
      policy,
      ledger,
      arrived.length,
    );
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
    const expectedReason = expectedUnsatisfiedReason(
      policy,
      ledger,
      arrivedCount,
    );
    assertCheckpoint(
      unsatisfiedReasonCode === expectedReason,
      'persisted join failure is inconsistent',
    );
  }
  return {
    joinInvocationKey,
    joinId: value.joinId,
    branchPath,
    iterationPath,
    policy,
    ledger,
    ...(selectedBranchIds === undefined ? {} : { selectedBranchIds }),
    ...(unsatisfiedReasonCode === undefined ? {} : { unsatisfiedReasonCode }),
  };
}
