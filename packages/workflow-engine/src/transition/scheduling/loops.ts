import { WorkflowEngineError } from '../../workflow-engine.errors.js';
import type {
  BranchScopePart,
  IterationScopePart,
  LoopState,
  OutputReference,
} from '../../workflow-execution.js';

export interface LoopAdmission {
  readonly loop: LoopState;
  readonly admittedOrdinals: readonly number[];
}

export function createLoopState(input: {
  readonly controlInvocationKey: string;
  readonly loopId: string;
  readonly branchPath: readonly BranchScopePart[];
  readonly iterationPath: readonly IterationScopePart[];
  readonly bodyRootNodeIds: readonly string[];
  readonly bodySinkNodeId: string;
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
  const iterationBudgetExceeded =
    input.maxConcurrency > input.maxIterations ||
    input.collectionSize > input.maxIterations ||
    input.collectionSize > input.remainingIterationBudget;
  if (iterationBudgetExceeded) {
    throw new WorkflowEngineError(
      'loop_limit_exceeded',
      'collection exceeds pinned loop limits',
    );
  }
  return {
    controlInvocationKey: input.controlInvocationKey,
    loopId: input.loopId,
    branchPath: input.branchPath,
    iterationPath: input.iterationPath,
    bodyRootNodeIds: input.bodyRootNodeIds,
    bodySinkNodeId: input.bodySinkNodeId,
    collection: input.collection,
    collectionChecksum: input.collectionChecksum,
    collectionSize: input.collectionSize,
    maxConcurrency: input.maxConcurrency,
    maxIterations: input.maxIterations,
    nextOrdinal: 0,
    completedPrefix: 0,
    activeOrdinals: [],
    terminalOrdinals: [],
  };
}

/** Admits iterations up to the loop's concurrency; the run budget was spent when the loop started. */
export function admitLoopIterations(loop: LoopState): LoopAdmission {
  const active = [...loop.activeOrdinals].sort((a, b) => a - b);
  const terminal = [...loop.terminalOrdinals].sort((a, b) => a - b);
  const all = [...active, ...terminal];
  if (
    new Set(all).size !== all.length ||
    all.some(
      (ordinal) =>
        ordinal < loop.completedPrefix || ordinal >= loop.collectionSize,
    )
  ) {
    throw new WorkflowEngineError(
      'loop_state_invalid',
      'loop ordinals are inconsistent',
    );
  }
  const capacity = Math.max(0, loop.maxConcurrency - active.length);
  const available = Math.min(capacity, loop.collectionSize - loop.nextOrdinal);
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
