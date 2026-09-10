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
}>;

type InvocationByKey = ReadonlyMap<string, Invocation>;

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
      (loop.terminalStatus === undefined
        ? complete
          ? control.status !== 'succeeded'
          : control.status !== 'waiting'
        : control.status !== loop.terminalStatus)
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
