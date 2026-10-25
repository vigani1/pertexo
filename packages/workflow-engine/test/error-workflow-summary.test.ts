import { expect, it } from 'vitest';
import { createCheckpoint, type InvocationState } from '../src/index.js';
import { errorWorkflowInput } from '../src/completion/error-workflow.js';
const id = '12345678-1234-4234-8234-123456789abc';
const invocation = (
  nodeId: string,
  status: InvocationState['status'],
): InvocationState => ({
  nodeId,
  invocationKey: nodeId,
  status,
  attemptNumber: 1,
});
const source = {
  ...invocation('source', 'failed'),
  failureHandling: {
    sinkInvocationKey: 'handler',
    disposition: 'pending' as const,
  },
};
it.each([
  {
    status: 'failed' as const,
    invocations: [source, invocation('handler', 'failed')],
    expected: 'handler',
  },
  {
    status: 'outcome_unknown' as const,
    invocations: [
      invocation('earlier', 'failed'),
      invocation('uncertain', 'outcome_unknown'),
    ],
    expected: 'uncertain',
  },
  {
    status: 'failed' as const,
    invocations: [
      {
        ...source,
        failureHandling: {
          sinkInvocationKey: 'handler',
          disposition: 'handled' as const,
        },
      },
    ],
    expected: null,
  },
  { status: 'timed_out' as const, invocations: [], expected: null },
  { status: 'timed_out' as const, invocations: [source], expected: null },
])(
  'selects the unhandled step that explains $status',
  ({ status, invocations, expected }) => {
    const summary = errorWorkflowInput({
      workspaceId: id,
      workflowId: id,
      workflowVersionId: id,
      workflowName: 'Safe metadata',
      runId: id,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 1,
        consumedThroughEventSequence: 0,
        checkpoint: {
          ...createCheckpoint({ workflowVersionId: id, iterationBudget: 200 }),
          runStatus: status,
          invocations,
        },
        events: [],
        nodeRunAdmissions: [],
        attempts: [],
      },
    });
    expect(summary.failedStep?.id ?? null).toBe(expected);
  },
);
