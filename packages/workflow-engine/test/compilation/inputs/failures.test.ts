import { describe, expect, it } from 'vitest';
import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';
import {
  graph,
  nodeCatalog,
  completedOutputs,
} from '../../support/executable-workflow.js';
import {
  expressionEvaluator,
  mappedExecutable,
} from '../../support/compilation/input-resolution.js';

describe('input resolution production operations', () => {
  it('maps a manual predecessor, run input and literal into core.set while omitting a missing path', async () => {
    const mappedGraph = structuredClone(graph());
    const specialLiteral = JSON.parse(
      '{"__proto__":{"safe":true},"nested":[{"__proto__":3}]}',
    ) as unknown;
    Object.assign(mappedGraph.nodes[1], {
      inputMappings: {
        customer: {
          kind: 'node_output',
          nodeId: 'manual',
          path: '$.customer',
        },
        requestedBy: { kind: 'run_input', path: '$.actor.name' },
        active: { kind: 'literal', value: true },
        special: { kind: 'literal', value: specialLiteral },
        omitted: { kind: 'run_input', path: '$.notProvided' },
      },
    });
    const executable = buildWorkflowExecutable({
      graph: mappedGraph,
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    const runInput = {
      customer: { id: 'customer-7', name: 'Ada' },
      actor: { name: 'Operator' },
    };
    let setInput: unknown;

    const manualOutcome = await executeNodeAttempt({
      runId: 'run-visual-mapping',
      nodeRunId: 'node-run-manual',
      attemptId: 'attempt-manual',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        nodeId: 'manual',
      }),
      nodeId: 'manual',
      runInput,
      completedNodeOutputs: [],
      registry: {
        execute: () => Promise.resolve({ kind: 'succeeded', output: runInput }),
      },
      signal: new AbortController().signal,
    });
    await executeNodeAttempt({
      runId: 'run-visual-mapping',
      nodeRunId: 'node-run-set',
      attemptId: 'attempt-set',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        nodeId: 'set',
      }),
      nodeId: 'set',
      runInput,
      completedNodeOutputs: completedOutputs({ manual: manualOutcome.output }),
      registry: {
        execute: (request) => {
          setInput = request.input;
          return Promise.resolve({ kind: 'succeeded', output: {} });
        },
      },
      signal: new AbortController().signal,
    });

    expect(setInput).toEqual({
      active: true,
      customer: { id: 'customer-7', name: 'Ada' },
      requestedBy: 'Operator',
      special: specialLiteral,
    });
    expect(JSON.stringify((setInput as Record<string, unknown>).special)).toBe(
      '{"__proto__":{"safe":true},"nested":[{"__proto__":3}]}',
    );
    expect(Object.prototype).not.toHaveProperty('safe');
    expect(setInput).not.toHaveProperty('omitted');
  });
  it('rejects invalid attempt and upstream identities before execution', async () => {
    const executable = mappedExecutable();
    const registry = {
      execute: (request: { readonly input: unknown }) =>
        Promise.resolve({
          kind: 'succeeded' as const,
          output: request.input as never,
        }),
    };
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: 'node:set',
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ terminate: {} }),
        registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
  it('preserves confirmed registry success after in-flight abort', async () => {
    const executable = mappedExecutable();

    const controller = new AbortController();
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: {
          execute: (request: { readonly input: unknown }) => {
            controller.abort();
            return Promise.resolve({
              kind: 'succeeded' as const,
              output: request.input as never,
            });
          },
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      attemptId: 'attempt-1',
      kind: 'succeeded',
    });
  });
  it('preserves typed executor failures and normalizes other rejections', async () => {
    const executable = mappedExecutable();

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-2',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: {
          execute: () => Promise.reject(new NodeExecutionAbortedError()),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });

    const unknownOutcome = new NodeExecutorFailure({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-unknown',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: { execute: () => Promise.reject(unknownOutcome) },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(unknownOutcome);

    const retry = new NodeExecutorFailure({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: false,
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-retry',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: { execute: () => Promise.reject(retry) },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(retry);

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-3',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: {
          execute: () =>
            Promise.reject(new DOMException('aborted', 'AbortError')),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-4',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
        expressionEvaluator,
        registry: {
          execute: () => Promise.reject(new Error('invalid output')),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'attempt_invalid',
      message: 'node execution failed',
    });
  });
});
