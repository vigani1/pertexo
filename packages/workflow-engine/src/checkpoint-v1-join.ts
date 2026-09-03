import type { JoinState } from './types.js';
import {
  assertCheckpoint,
  assertExactKeys,
  isInteger,
  isRecord,
  parseLedger,
  sortedUnique,
} from './checkpoint-shared.js';

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
  assertCheckpoint(
    value.branchPath === undefined || Array.isArray(value.branchPath),
    'join branch scope must be an array',
  );
  const branchPath = Array.isArray(value.branchPath)
    ? value.branchPath.map((part) => {
        assertCheckpoint(isRecord(part), 'join branch scope must be an object');
        assertExactKeys(part, ['nodeId', 'outputPort']);
        assertCheckpoint(
          typeof part.nodeId === 'string' &&
            part.nodeId.length > 0 &&
            typeof part.outputPort === 'string' &&
            part.outputPort.length > 0,
          'join branch scope is invalid',
        );
        return { nodeId: part.nodeId, outputPort: part.outputPort };
      })
    : [];
  assertCheckpoint(
    value.iterationPath === undefined || Array.isArray(value.iterationPath),
    'join iteration scope must be an array',
  );
  const iterationPath = Array.isArray(value.iterationPath)
    ? value.iterationPath.map((part) => {
        assertCheckpoint(
          isRecord(part),
          'join iteration scope must be an object',
        );
        assertExactKeys(part, ['loopNodeId', 'ordinal']);
        assertCheckpoint(
          typeof part.loopNodeId === 'string' &&
            part.loopNodeId.length > 0 &&
            isInteger(part.ordinal) &&
            part.ordinal >= 0,
          'join iteration scope is invalid',
        );
        return { loopNodeId: part.loopNodeId, ordinal: part.ordinal };
      })
    : [];
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
