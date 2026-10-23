import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
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
  it('treats Schedule envelopes as coordinator-owned trigger input', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ schedule: true }));
    const scheduledGraph = graph();
    const trigger = scheduledGraph.nodes[0];
    Object.assign(trigger, {
      definition: { key: 'core.schedule', version: 1 },
      configVersion: 1,
      config: {
        kind: 'interval',
        intervalMinutes: 5,
        misfirePolicy: 'skip',
      },
      inputMappings: {},
    });
    const executable = buildWorkflowExecutable({
      graph: scheduledGraph,
      catalog,
    });
    const envelope = {
      triggerId: '00000000-0000-4000-8000-000000000010',
      nodeId: 'manual',
      scheduledAt: '2026-08-20T10:00:00.000Z',
    } as const;
    let received: unknown;

    await executeNodeAttempt({
      runId: 'run-schedule',
      nodeRunId: 'node-run-schedule',
      attemptId: 'attempt-schedule',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        nodeId: 'manual',
      }),
      nodeId: 'manual',
      runInput: envelope,
      completedNodeOutputs: [],
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
  });
  it('requires canonical UUID output locators bound to inline attempt identity', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
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
      completedNodeOutputs: completedOutputs({ manual: { base: 3 } }),
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
        completedNodeOutputs: [
          {
            nodeId: 'manual',
            invocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000001',
              nodeId: 'manual',
              branchPath: ['condition:true'],
            }),
            value: { base: 3 },
          },
        ],
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
  it('keeps the key order of the data a step reads', async () => {
    const orderedGraph = structuredClone(graph());
    Object.assign(orderedGraph.nodes[1], {
      inputMappings: {
        row: { kind: 'run_input', path: '$' },
        upstream: { kind: 'node_output', nodeId: 'manual', path: '$' },
        literal: { kind: 'literal', value: { zeta: 1, alpha: 2 } },
      },
    });
    const executable = buildWorkflowExecutable({
      graph: orderedGraph,
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    let received: unknown;
    await executeNodeAttempt({
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
      runInput: { name: 'Ada', qty: 2, city: 'Berlin' },
      completedNodeOutputs: completedOutputs({
        manual: { total: 9, base: 3 },
      }),
      expressionEvaluator,
      registry: {
        execute: (request: { readonly input: unknown }) => {
          received = request.input;
          return Promise.resolve({
            kind: 'succeeded' as const,
            output: request.input as never,
          });
        },
      },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(received)).toBe(
      '{"row":{"name":"Ada","qty":2,"city":"Berlin"},"upstream":{"total":9,"base":3},"literal":{"zeta":1,"alpha":2}}',
    );
  });
});
