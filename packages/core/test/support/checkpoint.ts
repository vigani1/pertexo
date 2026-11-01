export function queuedCheckpoint(workflowVersionId: string) {
  return {
    checkpoint: {
      workflowVersionId,
      revision: 0,
      runStatus: 'queued',
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: [],
      invocations: [],
      joins: [],
      loops: [],
      remainingIterationBudget: 0,
      cancelRequested: false,
      deadlineExpired: false,
      branchSelections: [],
    },
  };
}
