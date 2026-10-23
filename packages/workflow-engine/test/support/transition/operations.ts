import type { ExecuteNodeAttemptInput } from '../../../src/index.js';
import { vi } from 'vitest';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  invocationKey,
} from '../../../src/index.js';
import {
  graph,
  nodeCatalog,
  completedOutputs,
} from '../executable-workflow.js';
export function standardExecutable() {
  return buildWorkflowExecutable({
    graph: graph(),
    catalog: composeExecutableCatalog(nodeCatalog()),
  });
}
export function successfulRegistry() {
  return {
    execute: vi.fn((request: { readonly input: unknown }) =>
      Promise.resolve({
        kind: 'succeeded' as const,
        output: request.input as never,
      }),
    ),
  };
}
export function setAttempt(
  overrides: Record<string, unknown> = {},
): ExecuteNodeAttemptInput {
  return {
    runId: 'run-1',
    nodeRunId: 'node-run-1',
    attemptId: 'attempt-1',
    executable: standardExecutable(),
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    invocationKey: invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: 'set',
    }),
    nodeId: 'set',
    runInput: {},
    completedNodeOutputs: completedOutputs({ manual: {} }),
    registry: successfulRegistry(),
    signal: new AbortController().signal,
    ...overrides,
  };
}
