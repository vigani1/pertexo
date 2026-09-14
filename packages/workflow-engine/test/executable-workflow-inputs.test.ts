import { afterAll, describe, expect, it } from 'vitest';
import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
  resolveSingleNodePreviewInput,
} from '../src/index.js';
import { graph, nodeRelease } from './executable-workflow.fixtures.js';

const expressionEvaluator = new JsonataEvaluator();
afterAll(async () => expressionEvaluator.shutdown());

function mappedExecutable() {
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
  return buildWorkflowExecutableV2({
    graph: mappedGraph,
    release: composeExecutableCompatibilityRelease(nodeRelease()),
  });
}

describe('input resolution production operations', () => {
  it.each([2, 3] as const)(
    'treats Schedule V%s envelopes as coordinator-owned trigger input',
    async (version) => {
      const release = composeExecutableCompatibilityRelease(
        nodeRelease({ schedule: true, scheduleVersion: version }),
      );
      const scheduledGraph = graph();
      const trigger = scheduledGraph.nodes[0];
      Object.assign(trigger, {
        definition: { key: 'core.schedule', version },
        configVersion: version,
        config: {
          kind: 'interval',
          intervalMinutes: 5,
          misfirePolicy: 'skip',
        },
        inputMappings: {},
      });
      const executable = buildWorkflowExecutableV2({
        graph: scheduledGraph,
        release,
      });
      const envelope = {
        schemaVersion: 1,
        triggerId: '00000000-0000-4000-8000-000000000010',
        nodeId: 'manual',
        scheduledAt: '2026-08-20T10:00:00.000Z',
      } as const;
      let received: unknown;

      await executeNodeAttempt({
        runId: `run-schedule-v${String(version)}`,
        nodeRunId: `node-run-schedule-v${String(version)}`,
        attemptId: `attempt-schedule-v${String(version)}`,
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'manual',
        }),
        nodeId: 'manual',
        runInput: envelope,
        completedNodeOutputs: {},
        registry: {
          execute: (request) => {
            received = request.input;
            return Promise.resolve({
              kind: 'succeeded',
              output: envelope,
            });
          },
        },
        signal: new AbortController().signal,
      });

      expect(received).toEqual(envelope);
    },
  );

  it('requires canonical UUID output locators bound to inline attempt identity', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
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

  it('resolves mapped input sources independently', async () => {
    const executable = mappedExecutable();
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
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
      invocationKey:
        '00000000-0000-4000-8000-000000000001|set|b:condition%3Atrue|i:',
      kind: 'succeeded',
    });
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { terminate: {} },
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
        completedNodeOutputs: { manual: { base: 3 } },
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
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

  it('contains hostile registry and expression-evaluator rejections', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const expressionGraph = structuredClone(graph());
    Object.assign(expressionGraph.nodes[1], {
      inputMappings: {
        expression: {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.value',
          policyVersion: 1,
        },
      },
    });
    const expressionExecutable = buildWorkflowExecutableV2({
      graph: expressionGraph,
      release,
    });
    const throwingName = new Error('private registry message');
    Object.defineProperty(throwingName, 'name', {
      get() {
        throw new Error('secondary name failure');
      },
    });
    const prototypeTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('secondary prototype failure');
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const base = {
      runId: 'run-hostile',
      nodeRunId: 'node-run-hostile',
      attemptId: 'attempt-hostile',
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        nodeId: 'set',
      }),
      nodeId: 'set',
      runInput: { value: 1 },
      completedNodeOutputs: { manual: {} },
      signal: new AbortController().signal,
    } as const;
    for (const rejection of [throwingName, prototypeTrap, revoked.proxy])
      await expect(
        executeNodeAttempt({
          ...base,
          executable,
          registry: {
            // Exercises classification of hostile non-Error Promise rejections.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            execute: () => Promise.reject(rejection),
          },
        }),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        message: 'node execution failed',
      });

    for (const rejection of [prototypeTrap, revoked.proxy]) {
      let registryCalls = 0;
      await expect(
        executeNodeAttempt({
          ...base,
          executable: expressionExecutable,
          expressionEvaluator: {
            // Exercises classification of hostile non-Error Promise rejections.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            evaluate: () => Promise.reject(rejection),
          },
          registry: {
            execute: () => {
              registryCalls += 1;
              return Promise.resolve({ kind: 'succeeded', output: {} });
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        message: 'mapping failed',
      });
      expect(registryCalls).toBe(0);
    }
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
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          invocationKey: invocationKey({
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
