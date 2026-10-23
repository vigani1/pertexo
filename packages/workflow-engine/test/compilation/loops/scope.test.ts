import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  nestedForEachGraph,
} from '../../support/executable-workflow.js';

describe('For Each production operations', () => {
  it.each([
    {
      nodeId: 'missing',
      iterationPath: [],
      message: 'node is not executable',
    },
    {
      nodeId: 'nested-body',
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      message: 'node invocation structured scope does not match the executable',
    },
    {
      nodeId: 'nested-body',
      iterationPath: [
        { loopNodeId: 'body-first', ordinal: 0 },
        { loopNodeId: 'loop', ordinal: 0 },
      ],
      message: 'node invocation structured scope does not match the executable',
    },
  ])(
    'rejects a missing node or mismatched ancestry before execution %#',
    async ({ nodeId, iterationPath, message }) => {
      const executable = buildWorkflowExecutable({
        graph: nestedForEachGraph(),
        catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
      });
      const workflowVersionId = '00000000-0000-4000-8000-000000000001';
      let executions = 0;
      await expect(
        executeNodeAttempt({
          runId: 'run-invalid-scope',
          nodeRunId: 'node-run-invalid-scope',
          attemptId: 'attempt-invalid-scope',
          executable,
          workflowVersionId,
          invocationKey: invocationKey({
            workflowVersionId,
            nodeId,
            iterationPath,
          }),
          nodeId,
          iterationPath,
          runInput: {},
          completedNodeOutputs: [],
          registry: {
            execute: () => {
              executions += 1;
              return Promise.resolve({ kind: 'succeeded', output: {} });
            },
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'attempt_invalid', message });
      expect(executions).toBe(0);
    },
  );
});
