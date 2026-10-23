import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('wait and control production operations', () => {
  it('settles durable waiting work on deadline or cancellation without reconciliation', async () => {
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
    const waitingPlan = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:00:30.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'wait',
          eventName: 'node.waiting',
          sequence: started.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: manual.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000024',
          attemptNumber: manual.attemptNumber,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000024',
          },
          resumeAt: '2026-08-21T10:00:00.000Z',
          waitKind: 'node_wait',
        },
      ],
      signal: new AbortController().signal,
    });
    const waiting = waitingPlan.checkpoint;

    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint.invocations[0]).toMatchObject({
      status: 'timed_out',
    });
    expect(expired.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(expired.checkpoint.runStatus).toBe('timed_out');
    expect(expired.events.map(({ name }) => name)).toEqual([
      'node.timed_out',
      'run.timed_out',
    ]);

    const canceled = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: waiting.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
    expect(canceled.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(canceled.checkpoint.runStatus).toBe('canceled');
    expect(canceled.events.map(({ name }) => name)).toEqual([
      'node.canceled',
      'run.canceled',
    ]);

    for (const observations of [
      [
        {
          kind: 'deadline_expired' as const,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
        {
          kind: 'cancel_requested' as const,
          sequence: waiting.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      [
        {
          kind: 'cancel_requested' as const,
          sequence: waiting.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
        {
          kind: 'deadline_expired' as const,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
    ]) {
      const simultaneous = await advanceWorkflow({
        runId: 'run-both',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: waiting,
        occurredAt: '2026-08-20T10:02:00.000Z',
        maximumAdmissions: 1,
        observations,
        signal: new AbortController().signal,
      });
      expect(simultaneous.checkpoint).toMatchObject({
        cancelRequested: true,
        deadlineExpired: true,
        runStatus: 'canceled',
      });
      expect(simultaneous.checkpoint.invocations[0]).toMatchObject({
        status: 'canceled',
      });
      expect(simultaneous.checkpoint.invocations[0]).not.toHaveProperty(
        'resumeAt',
      );
      expect(simultaneous.checkpoint.invocations[0]).not.toHaveProperty(
        'waitKind',
      );
      expect(simultaneous.attempts).toEqual([]);
      expect(simultaneous.events.map(({ name }) => name)).toEqual([
        'node.canceled',
        'run.canceled',
      ]);
    }
  });
  it('plans every materialized node run independently of the attempt cap', async () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const sourceGraph = graph();
    const parallel = {
      ...sourceGraph,
      edges: [],
      nodes: sourceGraph.nodes.map((node) => ({
        ...node,
        inputMappings: {},
      })),
    };
    const executable = buildWorkflowExecutable({ graph: parallel, catalog });
    const input = {
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
    } as const;
    const first = await advanceWorkflow(input);
    expect(first.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
      expect.objectContaining({
        nodeId: 'set',
        sideEffectClass: 'idempotent_with_key',
      }),
      expect.objectContaining({ nodeId: 'terminate', sideEffectClass: 'safe' }),
    ]);
    expect(first.attempts).toHaveLength(1);
    expect(await advanceWorkflow(input)).toEqual(first);

    const disabledGraph = structuredClone(graph());
    Object.assign(disabledGraph.nodes[0], { disabled: true });
    const disabledExecutable = buildWorkflowExecutable({
      graph: disabledGraph,
      catalog,
    });
    const skipped = await advanceWorkflow({
      ...input,
      executable: disabledExecutable,
    });
    expect(skipped.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
    ]);
    expect(skipped.attempts).toEqual([]);
    expect(skipped.events).toContainEqual(
      expect.objectContaining({ name: 'node.skipped', nodeId: 'manual' }),
    );
  });
});
