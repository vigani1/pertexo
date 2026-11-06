import { settleJoin } from '../join-settlement.js';
import { isRecord } from '@pertexo/workflow-model';
import type { JoinState } from '../workflow-execution.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  parseLedger,
  parseBranchPath,
  parseIterationPath,
  sortedUnique,
} from './fields.js';

type JoinPolicy = JoinState['policy'];
type JoinLedger = JoinState['ledger'];

export function parseJoin(value: unknown): JoinState {
  assertCheckpoint(isRecord(value), 'join must be an object');
  assertExactKeys(
    value,
    ['joinId', 'joinInvocationKey', 'policy', 'ledger'],
    [
      'selectedBranchIds',
      'unsatisfiedReasonCode',
      'branchPath',
      'iterationPath',
    ],
  );
  assertCheckpoint(
    typeof value.joinId === 'string' && value.joinId.length > 0,
    'joinId is required',
  );
  assertCheckpoint(
    typeof value.joinInvocationKey === 'string' &&
      value.joinInvocationKey.length > 0,
    'join invocation key is invalid',
  );
  const joinInvocationKey = value.joinInvocationKey;
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
  const selectedBranchIds = parseJoinSelection(
    value.selectedBranchIds,
    policy,
    ledger,
  );
  if (unsatisfiedReasonCode !== undefined) {
    assertCheckpoint(
      ledger.every(({ disposition }) => disposition !== 'pending'),
      'an unsatisfied join cannot contain pending branches',
    );
    const decision = settleJoin({ policy, ledger });
    const expectedReason =
      decision.kind === 'unsatisfied' ? decision.reasonCode : undefined;
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

function parseJoinSelection(
  value: unknown,
  policy: JoinPolicy,
  ledger: JoinLedger,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  assertCheckpoint(Array.isArray(value), 'selectedBranchIds must be an array');
  assertCheckpoint(
    value.every((item) => typeof item === 'string'),
    'selectedBranchIds must contain strings',
  );
  const selectedBranchIds = sortedUnique(value, 'selectedBranchIds');
  assertCheckpoint(
    ledger.every(({ disposition }) => disposition !== 'pending'),
    'a selected join cannot contain pending branches',
  );
  const decision = settleJoin({ policy, ledger });
  const satisfiable = decision.kind === 'satisfied';
  const expected = satisfiable ? decision.selectedBranchIds : [];
  assertCheckpoint(
    satisfiable &&
      selectedBranchIds.length === expected.length &&
      selectedBranchIds.every(
        (branchId, index) => branchId === expected[index],
      ),
    'persisted join selection is inconsistent',
  );
  return selectedBranchIds;
}
