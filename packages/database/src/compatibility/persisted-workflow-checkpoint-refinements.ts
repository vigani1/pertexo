import type { z } from 'zod';

type BranchScopePart = Readonly<{ nodeId: string; outputPort: string }>;
type IterationScopePart = Readonly<{ loopNodeId: string; ordinal: number }>;
type Invocation = Readonly<{
  invocationKey: string;
  nodeId: string;
  status: string;
  resumeAt?: string | undefined;
  output?: unknown;
  branchPath?: readonly BranchScopePart[] | undefined;
  iterationPath?: readonly IterationScopePart[] | undefined;
}>;
type Checkpoint = Readonly<{
  workflowVersionId: string;
  invocations: readonly Invocation[];
  branchSelections: readonly Readonly<{
    invocationKey: string;
    nodeId: string;
    selectedOutputPort: string;
  }>[];
  joins: readonly Readonly<{
    joinInvocationKey?: string | undefined;
    joinId: string;
    branchPath?: readonly BranchScopePart[] | undefined;
    iterationPath?: readonly IterationScopePart[] | undefined;
    policy:
      | Readonly<{ kind: 'all' }>
      | Readonly<{ kind: 'any' }>
      | Readonly<{ kind: 'count'; count: number }>;
    ledger: readonly Readonly<{
      branchId: string;
      disposition: string;
    }>[];
    selectedBranchIds?: readonly string[] | undefined;
    unsatisfiedReasonCode?: string | undefined;
  }>[];
  loops: readonly Readonly<{
    controlInvocationKey: string;
    loopId: string;
    branchPath: readonly BranchScopePart[];
    iterationPath: readonly IterationScopePart[];
    collection: unknown;
    collectionSize: number;
    nextOrdinal: number;
    activeOrdinals: readonly number[];
    terminalStatus?: string | undefined;
  }>[];
  initialIterationBudget?: number | undefined;
  remainingIterationBudget: number;
  cancelRequested: boolean;
  deadlineExpired: boolean;
}>;

type InvocationByKey = ReadonlyMap<string, Invocation>;
type Join = Checkpoint['joins'][number];

function requiredArrivals(
  policy: Join['policy'],
  arrivedCount: number,
): number {
  if (policy.kind === 'all') return arrivedCount;
  if (policy.kind === 'any') return 1;
  return policy.count;
}

function expectedUnsatisfiedReason(
  join: Join,
  arrivedCount: number,
  required: number,
): string | undefined {
  if (join.policy.kind !== 'all')
    return arrivedCount < required ? 'insufficient_arrivals' : undefined;
  if (join.ledger.some(({ disposition }) => disposition === 'failed'))
    return 'branch_failed';
  if (join.ledger.some(({ disposition }) => disposition === 'canceled'))
    return 'branch_canceled';
  return undefined;
}

function invocationStatusIsConsistent(
  checkpoint: Checkpoint,
  join: Join,
  selected: readonly string[] | undefined,
  invocation: Invocation | undefined,
): boolean {
  if (join.unsatisfiedReasonCode !== undefined)
    return invocation?.status === 'failed';
  if (selected !== undefined)
    return invocation !== undefined && invocation.status !== 'pending';
  return (
    invocation?.status === 'pending' ||
    ((checkpoint.cancelRequested || checkpoint.deadlineExpired) &&
      invocation?.status === 'canceled')
  );
}

function selectedBranchesAreConsistent(
  selected: readonly string[] | undefined,
  expected: readonly string[],
  branchIds: ReadonlySet<string>,
  terminal: boolean,
  satisfiable: boolean,
): boolean {
  if (selected === undefined) return true;
  return (
    terminal &&
    satisfiable &&
    new Set(selected).size === selected.length &&
    selected.length === expected.length &&
    selected.every(
      (branchId, index) =>
        branchId === expected[index] && branchIds.has(branchId),
    )
  );
}

export function refineJoinConsistency(
  checkpoint: Checkpoint,
  context: z.RefinementCtx,
): void {
  const joinKeys = new Set<string>();
  for (const join of checkpoint.joins) {
    const ledger = [...join.ledger].sort((left, right) =>
      left.branchId < right.branchId
        ? -1
        : left.branchId > right.branchId
          ? 1
          : 0,
    );
    const branchIds = new Set(ledger.map(({ branchId }) => branchId));
    const selected =
      join.selectedBranchIds === undefined
        ? undefined
        : [...join.selectedBranchIds].sort();
    const arrived = ledger
      .filter(({ disposition }) => disposition === 'arrived')
      .map(({ branchId }) => branchId);
    const required = requiredArrivals(join.policy, arrived.length);
    const terminal = ledger.every(
      ({ disposition }) => disposition !== 'pending',
    );
    const satisfiable =
      join.policy.kind === 'all'
        ? !ledger.some(
            ({ disposition }) =>
              disposition === 'failed' || disposition === 'canceled',
          )
        : arrived.length >= required;
    const expectedSelected = satisfiable ? arrived.slice(0, required) : [];
    const expectedReason = expectedUnsatisfiedReason(
      join,
      arrived.length,
      required,
    );
    const joinKey =
      join.joinInvocationKey ??
      scopedInvocationKey(
        checkpoint,
        join.joinId,
        join.branchPath ?? [],
        join.iterationPath ?? [],
      );
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === joinKey,
    );
    const statusIsConsistent = invocationStatusIsConsistent(
      checkpoint,
      join,
      selected,
      invocation,
    );
    if (
      joinKeys.has(joinKey) ||
      !statusIsConsistent ||
      branchIds.size !== ledger.length ||
      (join.policy.kind === 'count' && join.policy.count > ledger.length) ||
      (selected !== undefined && join.unsatisfiedReasonCode !== undefined) ||
      !selectedBranchesAreConsistent(
        selected,
        expectedSelected,
        branchIds,
        terminal,
        satisfiable,
      ) ||
      (join.unsatisfiedReasonCode !== undefined &&
        (!terminal || join.unsatisfiedReasonCode !== expectedReason))
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint join state is inconsistent',
        input: checkpoint,
      });
    joinKeys.add(joinKey);
  }
}

function scopedInvocationKey(
  checkpoint: Checkpoint,
  nodeId: string,
  branchPath: readonly BranchScopePart[],
  iterationPath: readonly IterationScopePart[],
): string {
  const branches = branchPath
    .map(
      ({ nodeId: branchNodeId, outputPort }) => `${branchNodeId}:${outputPort}`,
    )
    .join('/');
  const iterations = iterationPath
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  return `${encodeURIComponent(checkpoint.workflowVersionId)}|${encodeURIComponent(nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
}

export function refineBranchSelections(
  checkpoint: Checkpoint,
  invocations: InvocationByKey,
  context: z.RefinementCtx,
): void {
  const selections = new Map<string, string>();
  for (const selection of checkpoint.branchSelections) {
    const invocation = invocations.get(selection.invocationKey);
    const key = `${selection.invocationKey}\u0000${selection.nodeId}`;
    const existing = selections.get(key);
    if (
      invocation?.nodeId !== selection.nodeId ||
      invocation.status !== 'succeeded' ||
      invocation.output === undefined ||
      (existing !== undefined && existing !== selection.selectedOutputPort)
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint branch selection is inconsistent',
        input: checkpoint,
      });
    selections.set(key, selection.selectedOutputPort);
  }
}

export function refineInvocationScopes(
  checkpoint: Checkpoint,
  context: z.RefinementCtx,
): void {
  for (const invocation of checkpoint.invocations) {
    if (
      (invocation.branchPath !== undefined ||
        invocation.iterationPath !== undefined) &&
      invocation.invocationKey !==
        scopedInvocationKey(
          checkpoint,
          invocation.nodeId,
          invocation.branchPath ?? [],
          invocation.iterationPath ?? [],
        )
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint invocation scope is inconsistent',
        input: checkpoint,
      });
  }
}

export function refineJoinScopes(
  checkpoint: Checkpoint,
  invocations: InvocationByKey,
  context: z.RefinementCtx,
): void {
  for (const join of checkpoint.joins) {
    const key =
      join.joinInvocationKey ??
      scopedInvocationKey(
        checkpoint,
        join.joinId,
        join.branchPath ?? [],
        join.iterationPath ?? [],
      );
    const invocation = invocations.get(key);
    if (
      invocation?.nodeId !== join.joinId ||
      JSON.stringify(invocation.branchPath ?? []) !==
        JSON.stringify(join.branchPath ?? []) ||
      JSON.stringify(invocation.iterationPath ?? []) !==
        JSON.stringify(join.iterationPath ?? [])
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint join scope is inconsistent',
        input: checkpoint,
      });
  }
}

export function refineLoopsBudgetAndWaits(
  checkpoint: Checkpoint,
  invocations: InvocationByKey,
  context: z.RefinementCtx,
): void {
  const loopKeys = new Set<string>();
  for (const loop of checkpoint.loops) {
    const control = invocations.get(loop.controlInvocationKey);
    const complete =
      loop.nextOrdinal === loop.collectionSize &&
      loop.activeOrdinals.length === 0;
    const expectedControlStatus =
      loop.terminalStatus ?? (complete ? 'succeeded' : 'waiting');
    if (
      loopKeys.has(loop.controlInvocationKey) ||
      loop.controlInvocationKey !==
        scopedInvocationKey(
          checkpoint,
          loop.loopId,
          loop.branchPath,
          loop.iterationPath,
        ) ||
      control?.nodeId !== loop.loopId ||
      JSON.stringify(control.branchPath ?? []) !==
        JSON.stringify(loop.branchPath) ||
      JSON.stringify(control.iterationPath ?? []) !==
        JSON.stringify(loop.iterationPath) ||
      JSON.stringify(control.output) !== JSON.stringify(loop.collection) ||
      control.status !== expectedControlStatus
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint loop ownership is inconsistent',
        input: checkpoint,
      });
    loopKeys.add(loop.controlInvocationKey);
  }
  if (
    checkpoint.loops.length > 0 &&
    checkpoint.initialIterationBudget === undefined
  )
    context.addIssue({
      code: 'custom',
      message: 'checkpoint loop budget is missing',
      input: checkpoint,
    });
  if (
    checkpoint.initialIterationBudget !== undefined &&
    checkpoint.remainingIterationBudget +
      checkpoint.loops.reduce(
        (total, loop) => total + loop.collectionSize,
        0,
      ) !==
      checkpoint.initialIterationBudget
  )
    context.addIssue({
      code: 'custom',
      message: 'checkpoint loop budget is inconsistent',
      input: checkpoint,
    });
  for (const invocation of checkpoint.invocations)
    if (
      invocation.status === 'waiting' &&
      invocation.resumeAt === undefined &&
      !loopKeys.has(invocation.invocationKey)
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint undated wait is not a loop barrier',
        input: checkpoint,
      });
}
