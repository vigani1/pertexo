import { describe, expect, it } from 'vitest';

import type { WorkflowCheckpoint } from '../../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../src/server.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';

const VERSION_ID = '00000000-0000-4000-8000-000000000001';
const MANUAL_ATTEMPT = '00000000-0000-4000-8000-000000000011';
const SET_ATTEMPT = '00000000-0000-4000-8000-000000000012';
const STARTED_AT = '2026-08-20T10:00:00.000Z';
const RESUME_AT = '2026-08-20T11:00:00.000Z';
const manualKey = invocationKey({
  workflowVersionId: VERSION_ID,
  nodeId: 'manual',
});
const setKey = invocationKey({ workflowVersionId: VERSION_ID, nodeId: 'set' });

const executable = buildWorkflowExecutable({
  graph: graph(),
  catalog: composeExecutableCatalog(nodeCatalog()),
});

function advance(checkpoint: WorkflowCheckpoint, observations: unknown[]) {
  return advanceWorkflow({
    runId: 'run-replay',
    executable,
    workflowVersionId: VERSION_ID,
    checkpoint,
    observations,
    occurredAt: STARTED_AT,
    maximumAdmissions: 1,
    signal: new AbortController().signal,
  });
}

/** manual succeeded; set started and is waiting until RESUME_AT. */
async function waitingRun() {
  const admitted = await advance(
    createCheckpoint({ workflowVersionId: VERSION_ID, iterationBudget: 0 }),
    [],
  );
  const first = admitted.checkpoint.nextEventSequence;
  const setAdmitted = await advance(admitted.checkpoint, [
    {
      sequence: first,
      occurredAt: STARTED_AT,
      kind: 'outcome',
      invocationKey: manualKey,
      status: 'succeeded',
      output: { kind: 'inline', attemptId: MANUAL_ATTEMPT },
      attemptId: MANUAL_ATTEMPT,
      attemptNumber: 1,
    },
  ]);
  const next = setAdmitted.checkpoint.nextEventSequence;
  const started = {
    sequence: next,
    occurredAt: STARTED_AT,
    kind: 'cursor_only',
    eventName: 'node.started',
    invocationKey: setKey,
    attemptId: SET_ATTEMPT,
    attemptNumber: 1,
  };
  const waiting = {
    sequence: next + 1,
    occurredAt: STARTED_AT,
    kind: 'wait',
    eventName: 'node.waiting',
    invocationKey: setKey,
    attemptId: SET_ATTEMPT,
    attemptNumber: 1,
    resumeAt: RESUME_AT,
    waitKind: 'node_wait',
    output: { kind: 'inline', attemptId: SET_ATTEMPT },
  };
  const saved = await advance(setAdmitted.checkpoint, [started, waiting]);
  return {
    admitted: setAdmitted.checkpoint,
    saved: saved.checkpoint,
    started,
    waiting,
  };
}

/** The same wait recorded as a retry backoff, which carries no output. */
function asRetryWait(wait: Readonly<Record<string, unknown>>) {
  const { output: _output, ...rest } = wait;
  return {
    ...rest,
    eventName: 'node.retry_scheduled',
    waitKind: 'retry_backoff',
  };
}

describe('a persisted observation window delivered again after its checkpoint was saved', () => {
  it('accepts the start and wait it already applied, without changing the run', async () => {
    const { saved, started, waiting } = await waitingRun();
    expect(
      saved.invocations.find((n) => n.invocationKey === setKey),
    ).toMatchObject({ status: 'waiting', resumeAt: RESUME_AT });

    const replayed = await advance(saved, [started, waiting]);

    expect(replayed.events).toEqual([]);
    expect(replayed.checkpoint.invocations).toEqual(saved.invocations);
    expect(replayed.checkpoint.nextEventSequence).toBe(saved.nextEventSequence);
  });

  it.each([
    ['a wait for another time', { resumeAt: '2026-08-20T12:00:00.000Z' }],
    ['a wait from another attempt', { attemptNumber: 2 }],
    ['a wait on a step that is not waiting', { invocationKey: manualKey }],
  ])('refuses %s', async (_case, change) => {
    const { saved, started, waiting } = await waitingRun();
    await expect(
      advance(saved, [started, { ...waiting, ...change }]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('refuses a retry wait where it applied a step wait', async () => {
    const { saved, started, waiting } = await waitingRun();
    await expect(
      advance(saved, [started, asRetryWait(waiting)]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it.each([
    ['a start from another attempt', { attemptNumber: 2 }],
    [
      'a start of a step the run never admitted',
      {
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'terminate',
        }),
      },
    ],
  ])('refuses %s', async (_case, change) => {
    const { saved, started, waiting } = await waitingRun();
    await expect(
      advance(saved, [{ ...started, ...change }, waiting]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('accepts a cancellation it already applied and refuses one it never saw', async () => {
    const { saved } = await waitingRun();
    const cancel = {
      sequence: saved.nextEventSequence,
      occurredAt: STARTED_AT,
      kind: 'cancel_requested',
    };
    const canceled = await advance(saved, [cancel]);
    expect(canceled.checkpoint.cancelRequested).toBe(true);

    const replayed = await advance(canceled.checkpoint, [cancel]);
    expect(replayed.events).toEqual([]);
    expect(replayed.checkpoint.runStatus).toBe(canceled.checkpoint.runStatus);

    await expect(
      advance(saved, [{ ...cancel, sequence: saved.nextEventSequence - 1 }]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
});

describe('the same sequence delivered twice in one window', () => {
  it.each([
    ['a step wait', (wait: Readonly<Record<string, unknown>>) => wait],
    ['a retry wait', asRetryWait],
  ])('applies an identical start and %s once', async (_case, shape) => {
    const { admitted, started, waiting } = await waitingRun();
    const wait = shape(waiting);
    const once = await advance(admitted, [started, wait]);

    const twice = await advance(admitted, [started, started, wait, wait]);

    expect(twice.consumedThroughEventSequence).toBe(waiting.sequence);
    expect(twice.checkpoint).toEqual(once.checkpoint);
  });

  it('applies an identical cancellation once', async () => {
    const { saved } = await waitingRun();
    const cancel = {
      sequence: saved.nextEventSequence,
      occurredAt: STARTED_AT,
      kind: 'cancel_requested',
    };
    const once = await advance(saved, [cancel]);

    expect(await advance(saved, [cancel, cancel])).toEqual(once);
  });

  it.each([
    ['another time', { resumeAt: '2026-08-20T12:00:00.000Z' }],
    ['another event', { eventName: 'node.retry_scheduled' }],
    ['when it was observed', { occurredAt: '2026-08-20T10:00:01.000Z' }],
  ])(
    'refuses two waits under one sequence that disagree on %s',
    async (_case, change) => {
      const { admitted, started, waiting } = await waitingRun();
      await expect(
        advance(admitted, [started, waiting, { ...waiting, ...change }]),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
    },
  );

  it('refuses a step wait and a retry wait under one sequence', async () => {
    const { admitted, started, waiting } = await waitingRun();
    await expect(
      advance(admitted, [started, waiting, asRetryWait(waiting)]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it.each([
    ['their event', { eventName: 'node.progress' }],
    ['their attempt', { attemptId: '00000000-0000-4000-8000-000000000013' }],
  ])(
    'refuses two cursor facts under one sequence that disagree on %s',
    async (_case, change) => {
      const { admitted, started, waiting } = await waitingRun();
      await expect(
        advance(admitted, [started, { ...started, ...change }, waiting]),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
    },
  );
});
