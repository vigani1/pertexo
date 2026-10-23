import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('wait and control production operations', () => {
  it('orders simultaneous due resumptions independently of loader row order', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const sourceGraph = graph();
    const executable = buildWorkflowExecutable({
      graph: {
        ...sourceGraph,
        edges: [],
        nodes: sourceGraph.nodes.map((node) => ({
          ...node,
          inputMappings: {},
        })),
      },
      catalog,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 2,
      observations: [],
      signal: new AbortController().signal,
    });
    const waiting = structuredClone(started.checkpoint);
    for (const invocation of waiting.invocations.filter(
      ({ status }) => status === 'running',
    ))
      Object.assign(invocation, {
        status: 'waiting',
        resumeAt: '2026-08-20T10:05:00.000Z',
        waitKind: 'retry_backoff',
      });
    const dues = waiting.invocations
      .filter(({ status }) => status === 'waiting')
      .map(({ invocationKey }) => ({
        kind: 'due_at' as const,
        occurredAt: '2026-08-20T10:05:00.000Z',
        invocationKey,
      }));
    expect(dues).toHaveLength(2);
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:05:00.000Z',
      maximumAdmissions: 2,
      signal: new AbortController().signal,
    } as const;
    const forward = await advanceWorkflow({ ...input, observations: dues });
    const reverse = await advanceWorkflow({
      ...input,
      observations: [...dues].reverse(),
    });
    expect(reverse).toEqual(forward);
    expect(
      forward.events.filter(({ name }) => name === 'node.ready'),
    ).toHaveLength(2);
    expect(forward.nodeRunAdmissions).toEqual([]);
    expect(forward.attempts).toHaveLength(2);
  });
  it('applies persisted cancel and deadline controls before materializing work', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const initial = createCheckpoint({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 0,
    });
    const canceled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: initial.nextEventSequence,
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.nodeRunAdmissions).toEqual([]);
    expect(canceled.attempts).toEqual([]);
    expect(
      canceled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.canceled', initial.nextEventSequence + 1]]);

    const timedOut = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(timedOut.expectedNextEventSequence).toBe(initial.nextEventSequence);
    expect(timedOut.consumedThroughEventSequence).toBe(
      initial.nextEventSequence - 1,
    );
    expect(timedOut.checkpoint).toMatchObject({
      cancelRequested: false,
      deadlineExpired: true,
      runStatus: 'timed_out',
    });
    expect(timedOut.nodeRunAdmissions).toEqual([]);
    expect(timedOut.attempts).toEqual([]);
    expect(
      timedOut.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', initial.nextEventSequence]]);
  });
  it('persists deadline state while active work reconciles before run timeout', async () => {
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
    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint).toMatchObject({
      deadlineExpired: true,
      runStatus: 'running',
    });
    expect(expired.attempts).toEqual([]);
    expect(expired.nodeRunAdmissions).toEqual([]);

    const externalSequence = expired.checkpoint.nextEventSequence;
    const reconciled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: expired.checkpoint,
      occurredAt: '2026-08-20T10:03:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:03:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000023',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'timed_out',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(reconciled.checkpoint.runStatus).toBe('timed_out');
    expect(
      reconciled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', externalSequence + 1]]);
  });
});
