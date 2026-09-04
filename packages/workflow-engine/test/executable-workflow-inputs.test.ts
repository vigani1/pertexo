import { afterAll, describe, expect, it } from 'vitest';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';

import {
  NodeExecutionAbortedError,
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
  resolveSingleNodePreviewInput,
  nodeRelease,
  graph,
} from './executable-workflow.fixtures.js';

const expressionEvaluator = new JsonataEvaluator();
afterAll(async () => expressionEvaluator.shutdown());

describe('input resolution production operations', () => {
  it('requires canonical UUID output locators bound to inline attempt identity', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const base = {
      sequence: started.checkpoint.nextEventSequence,
      occurredAt: '2026-08-20T10:01:00.000Z',
      attemptId: '00000000-0000-4000-8000-000000000031',
      attemptNumber: manual.attemptNumber,
      kind: 'outcome',
      invocationKey: manual.invocationKey,
      status: 'succeeded',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      signal: new AbortController().signal,
    } as const;
    for (const output of [
      { kind: 'inline', attemptId: '00000000-0000-4000-8000-000000000032' },
      { kind: 'artifact', artifactId: 'NOT-A-UUID' },
      { kind: 'artifact', artifactId: '00000000-0000-4000-8000-00000000003A' },
    ] as const)
      await expect(
        advanceWorkflow({ ...input, observations: [{ ...base, output }] }),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('resolves mapped inputs and preserves confirmed success after abort', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const mappedGraph = structuredClone(graph());
    Object.assign(mappedGraph.nodes[1], {
      inputMappings: {
        literal: { kind: 'literal', value: null },
        fromRun: { kind: 'run_input', path: '$.name' },
        fromNode: {
          kind: 'node_output',
          nodeId: 'manual',
          path: '$.base',
        },
        missing: { kind: 'run_input', path: '$.absent' },
        expression: {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.count + nodeOutputs.manual.base',
          policyVersion: 1,
        },
      },
    });
    const executable = buildWorkflowExecutableV2({
      graph: mappedGraph,
      release,
    });
    let received: unknown;
    const registry = {
      execute: (request: { readonly input: unknown }) => {
        received = request.input;
        return Promise.resolve({
          kind: 'succeeded' as const,
          output: request.input as never,
        });
      },
    };
    const outcome = await executeNodeAttempt({
      runId: 'run-1',
      nodeRunId: 'node-run-1',
      attemptId: 'attempt-1',
      executable,
      workflowVersionId: 'version-1',
      invocationKey: invocationKey({
        workflowVersionId: 'version-1',
        nodeId: 'set',
      }),
      nodeId: 'set',
      runInput: { name: 'Ada', count: 2 },
      completedNodeOutputs: { manual: { base: 3 } },
      expressionEvaluator,
      registry,
      signal: new AbortController().signal,
    });
    expect(received).toEqual({
      expression: 5,
      fromNode: 3,
      fromRun: 'Ada',
      literal: null,
    });
    expect(outcome).toMatchObject({
      runId: 'run-1',
      nodeRunId: 'node-run-1',
      attemptId: 'attempt-1',
      nodeId: 'set',
      kind: 'succeeded',
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-branch',
        attemptId: 'attempt-branch',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
          branchPath: ['condition:true'],
        }),
        nodeId: 'set',
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        expressionEvaluator,
        registry,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      invocationKey: 'version-1|set|b:condition%3Atrue|i:',
      kind: 'succeeded',
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: 'node:set',
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { terminate: {} },
        registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });

    const controller = new AbortController();
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-2',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        expressionEvaluator,
        registry: {
          execute: () => Promise.reject(new NodeExecutionAbortedError()),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });

    const { NodeExecutorFailure } = await import('@pertexo/node-sdk/server');
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
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
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

  it.each([
    ['core.manual', {}],
    ['core.webhook', { webhook: true }],
    ['core.schedule', { schedule: true }],
  ] as const)(
    'passes accepted run input to a %s trigger root',
    async (key, releaseOptions) => {
      const triggerGraph = structuredClone(graph());
      const trigger = triggerGraph.nodes[0];
      Object.assign(trigger, { definition: { key, version: 1 } });
      const executable = buildWorkflowExecutableV2({
        graph: triggerGraph,
        release: composeExecutableCompatibilityRelease(
          nodeRelease(releaseOptions),
        ),
      });
      const runInput = { accepted: true, source: key };

      await expect(
        executeNodeAttempt({
          runId: 'run-trigger',
          nodeRunId: 'node-run-trigger',
          attemptId: 'attempt-trigger',
          executable,
          workflowVersionId: 'version-1',
          invocationKey: invocationKey({
            workflowVersionId: 'version-1',
            nodeId: 'manual',
          }),
          nodeId: 'manual',
          runInput,
          completedNodeOutputs: {},
          registry: {
            execute: (request) =>
              Promise.resolve({
                kind: 'succeeded',
                output: request.input as never,
              }),
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ output: runInput });
    },
  );

  it('resolves isolated preview inputs through the production mapping path', async () => {
    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            expression: {
              expression: 'runInput.count * 2',
              kind: 'expression',
              language: 'jsonata',
              policyVersion: 1,
            },
            fromRun: { kind: 'run_input', path: '$.name' },
            literal: { kind: 'literal', value: true },
            missing: { kind: 'run_input', path: '$.absent' },
          },
        },
        runInput: { count: 4, name: 'Ada' },
        expressionEvaluator,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ expression: 8, fromRun: 'Ada', literal: true });

    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            upstream: {
              kind: 'node_output',
              nodeId: 'another-node',
              path: '$.value',
            },
          },
        },
        runInput: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it('classifies aggregate mapped-input overflow as an invalid attempt', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const repeatedGraph = structuredClone(graph());
    Object.assign(repeatedGraph.nodes[1], {
      inputMappings: {
        first: { kind: 'run_input', path: '$.large' },
        second: { kind: 'run_input', path: '$.large' },
      },
    });
    const executable = buildWorkflowExecutableV2({
      graph: repeatedGraph,
      release,
    });
    let executions = 0;
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { large: 'x'.repeat(600_000) },
        completedNodeOutputs: { manual: {} },
        registry: {
          execute: () => {
            executions += 1;
            return Promise.resolve({ kind: 'succeeded' as const, output: {} });
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'attempt_invalid',
      message: 'mapped input exceeds runtime limits',
    });
    expect(executions).toBe(0);
  });
});
