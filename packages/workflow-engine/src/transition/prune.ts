import { branchPathHasPrefix, iterationPathHasPrefix } from '../scope.js';
import type { InvocationState, LoopState } from '../types.js';
import {
  isTerminalNodeStatus,
  type MutableWorkflowTransition,
} from './state.js';

function iterationOwns(
  loop: LoopState,
  ordinal: number,
  invocation: InvocationState,
): boolean {
  return (
    iterationPathHasPrefix(invocation.iterationPath, [
      ...loop.iterationPath,
      { loopNodeId: loop.loopId, ordinal },
    ]) && branchPathHasPrefix(invocation.branchPath, loop.branchPath)
  );
}

/** The body seam forbids consumers outside an iteration. Every owner inside it
 * must settle before its references can leave the active checkpoint. */
export function pruneFinishedIterations(state: MutableWorkflowTransition) {
  const invocations = [...state.invocations.values()];
  const prunedKeys = new Set<string>();
  for (const loop of state.loops.values()) {
    for (const ordinal of loop.terminalOrdinals) {
      const owners = invocations.filter((invocation) =>
        iterationOwns(loop, ordinal, invocation),
      );
      if (owners.every(({ status }) => isTerminalNodeStatus(status)))
        for (const owner of owners) prunedKeys.add(owner.invocationKey);
    }
  }
  let retiredIterationBudget = state.current.retiredIterationBudget ?? 0;
  const loops: LoopState[] = [];
  for (const loop of state.loops.values()) {
    if (prunedKeys.has(loop.controlInvocationKey)) {
      retiredIterationBudget += loop.collectionSize;
      continue;
    }
    let completedPrefix = loop.completedPrefix;
    while (
      loop.terminalOrdinals.includes(completedPrefix) &&
      !invocations.some(
        (invocation) =>
          !prunedKeys.has(invocation.invocationKey) &&
          iterationOwns(loop, completedPrefix, invocation),
      )
    )
      completedPrefix += 1;
    loops.push({
      ...loop,
      completedPrefix,
      terminalOrdinals: loop.terminalOrdinals.filter(
        (ordinal) => ordinal >= completedPrefix,
      ),
    });
  }
  return {
    invocations: invocations.filter(
      ({ invocationKey }) => !prunedKeys.has(invocationKey),
    ),
    prunedInvocations: invocations.filter(({ invocationKey }) =>
      prunedKeys.has(invocationKey),
    ),
    prunedKeys,
    loops,
    joins: [...state.joins.values()].filter(
      ({ joinInvocationKey }) => !prunedKeys.has(joinInvocationKey),
    ),
    branchSelections: state.branchSelections.filter(
      ({ invocationKey }) => !prunedKeys.has(invocationKey),
    ),
    retiredIterationBudget,
  };
}
