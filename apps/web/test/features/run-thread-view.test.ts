// @vitest-environment node
import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
  WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import { describe, expect, it } from 'vitest';
import { describeRunEvent } from '@/features/workflow-runs/model/event-copy';
import { describeRunSentence } from '@/features/workflow-runs/model/run-sentence';
import { describeStepError } from '@/features/workflow-runs/model/step-error-copy';
import { stepTag } from '@/features/workflow-runs/model/step-copy';
import {
  buildThreadView,
  humanizeDefinitionKey,
  segmentPlacement,
} from '@/features/workflow-runs/model/thread-view';

const start = Date.parse('2026-09-24T14:31:00.000Z');

function at(seconds: number): string {
  return new Date(start + seconds * 1_000).toISOString();
}

function runSummary(
  status: WorkflowRunSummary['status'],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status,
    triggerType: 'webhook',
    createdAt: at(0),
    updatedAt: at(0),
    startedAt: at(0),
    completedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function node(
  nodeId: string,
  status: WorkflowNodeRunSummary['status'],
  overrides: Partial<WorkflowNodeRunSummary> = {},
): WorkflowNodeRunSummary {
  return {
    id: `11111111-1111-4111-8111-11111111111${String(nodeId.length % 10)}`,
    nodeId,
    invocationKey: `${nodeId}:0`,
    status,
    currentAttemptNumber: 1,
    startedAt: at(1),
    completedAt: null,
    resumeAt: null,
    safeErrorCode: null,
    ...overrides,
  };
}

let sequence = 0;
function nodeEvent(
  type: WorkflowRunEvent['type'],
  seconds: number,
  payload: Partial<WorkflowRunEvent['payload']> = {},
): WorkflowRunEvent {
  sequence += 1;
  return {
    sequence,
    type,
    createdAt: at(seconds),
    payload: {
      schemaVersion: 1,
      nodeId: 'send-receipt',
      invocationKey: 'send-receipt:0',
      ...payload,
    },
  };
}

const graph = {
  schemaVersion: 1 as const,
  nodes: [
    {
      id: 'post-erp',
      label: 'Post to ERP',
      definition: { key: 'core.http_request', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'send-receipt',
      label: 'Send receipt',
      definition: { key: 'email.send_message', version: 1 },
      position: { x: 200, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'done',
      definition: { key: 'core.stop_run', version: 1 },
      position: { x: 400, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
  settings: {},
} as unknown as NonNullable<Parameters<typeof buildThreadView>[0]['graph']>;

describe('thread view', () => {
  it('turns attempts, a scheduled retry and a running attempt into one row', () => {
    sequence = 0;
    const events = [
      nodeEvent('node.started', 4, { attemptNumber: 1 }),
      nodeEvent('node.retry_scheduled', 5, {
        attemptNumber: 1,
        dueAt: at(35),
        safeErrorCode: 'provider.unavailable',
      }),
      nodeEvent('node.started', 35, { attemptNumber: 2 }),
    ];
    const view = buildThreadView({
      run: runSummary('running'),
      nodes: [
        node('post-erp', 'succeeded', { completedAt: at(3) }),
        node('send-receipt', 'running', { currentAttemptNumber: 2 }),
      ],
      events,
      graph,
      nowMs: start + 47_000,
    });

    expect(view.rows.map((row) => row.label)).toEqual([
      'Post to ERP',
      'Send receipt',
      'Stop run',
    ]);
    const [erp, receipt, done] = view.rows;
    expect(erp?.segments).toEqual([
      expect.objectContaining({
        kind: 'attempt',
        tone: 'success',
        end: 'knot',
      }),
    ]);
    expect(
      receipt?.segments.map((segment) => [segment.kind, segment.tone]),
    ).toEqual([
      ['attempt', 'failure'],
      ['wait', 'waiting'],
      ['attempt', 'live'],
    ]);
    expect(receipt?.segments[2]?.endMs).toBeNull();
    expect(receipt?.story.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ['attempt', 'failed'],
      ['retry', 'scheduled'],
      ['attempt', 'running'],
    ]);
    expect(receipt?.story[0]?.safeErrorCode).toBe('provider.unavailable');
    expect(receipt?.story[1]?.endedAt).toBe(at(35));
    expect(done?.status).toBe('not_started');
    expect(done?.segments[0]).toMatchObject({ kind: 'pending', endMs: null });
    if (receipt === undefined) throw new Error('Missing Send receipt row');
    expect(stepTag(receipt, start + 47_000)).toBe('attempt 2');
    expect(view.ticks[0]).toEqual({ offsetMs: 0, label: '0' });
  });

  it('names the retrying step in the run sentence and counts down the wait', () => {
    sequence = 0;
    const nowMs = start + 20_000;
    const view = buildThreadView({
      run: runSummary('running'),
      nodes: [node('send-receipt', 'waiting')],
      events: [
        nodeEvent('node.started', 4, { attemptNumber: 1 }),
        nodeEvent('node.retry_scheduled', 5, { dueAt: at(35) }),
      ],
      graph,
      nowMs,
    });
    const receipt = view.rows.find((row) => row.nodeId === 'send-receipt');
    expect(describeRunSentence(runSummary('running'), view.rows, nowMs)).toBe(
      'Retrying Send receipt',
    );
    expect(receipt === undefined ? '' : stepTag(receipt, nowMs)).toBe(
      'retry in 15.0 s',
    );
    expect(view.endMs).toBe(start + 35_000);
  });

  it('falls back to node summaries when events are gone', () => {
    const view = buildThreadView({
      run: runSummary('failed', { completedAt: at(9) }),
      nodes: [
        node('send-receipt', 'failed', {
          currentAttemptNumber: 3,
          completedAt: at(9),
          safeErrorCode: 'connection.reauthorization_required',
        }),
      ],
      events: [],
      nowMs: start + 60_000,
    });
    const [row] = view.rows;
    expect(row?.label).toBe('send-receipt');
    expect(row?.segments).toEqual([
      expect.objectContaining({
        kind: 'attempt',
        tone: 'failure',
        end: 'fray',
      }),
    ]);
    expect(row?.safeErrorCode).toBe('connection.reauthorization_required');
    expect(
      describeRunSentence(
        runSummary('failed', { completedAt: at(9) }),
        view.rows,
        start + 60_000,
      ),
    ).toBe('Failed at send-receipt after 3 attempts');
  });

  it('places open segments at now and clamps them to the axis', () => {
    const view = { startMs: 0, endMs: 10_000 };
    expect(
      segmentPlacement(
        view,
        { kind: 'attempt', tone: 'live', startMs: 2_000, endMs: null },
        6_000,
      ),
    ).toEqual({ left: 20, width: 40 });
    expect(
      segmentPlacement(
        view,
        { kind: 'wait', tone: 'waiting', startMs: -5_000, endMs: 20_000 },
        6_000,
      ),
    ).toEqual({ left: 0, width: 100 });
  });
});

describe('run copy', () => {
  it('describes finished runs in one sentence', () => {
    const done = runSummary('succeeded', { completedAt: at(4.2) });
    expect(describeRunSentence(done, [], start)).toBe('Succeeded in 4.2 s');
    expect(
      describeRunSentence(
        runSummary('running', { cancelRequestedAt: at(3) }),
        [],
        start,
      ),
    ).toBe('Stopping…');
    expect(describeRunSentence(runSummary('queued'), [], start)).toBe(
      'Waiting to start',
    );
  });

  it('turns error codes into sentences with a fix and keeps unknown codes honest', () => {
    expect(
      describeStepError('connection.reauthorization_required'),
    ).toMatchObject({
      sentence: 'The connection this step uses needs to be reconnected.',
      fix: 'reconnect',
    });
    expect(describeStepError('provider.rate_limited').sentence).toMatch(
      /slow down/u,
    );
    expect(describeStepError('provider.something_new')).toBe(
      describeStepError('provider.unavailable'),
    );
    expect(describeStepError('mystery.code').sentence).toBe(
      'This step stopped with an error.',
    );
  });

  it('humanises events with offsets and step names', () => {
    sequence = 0;
    const line = describeRunEvent(
      nodeEvent('node.retry_scheduled', 5, { dueAt: at(35), attemptNumber: 2 }),
      start,
      () => 'Send receipt',
    );
    expect(line).toMatchObject({
      offset: '+5.0 s',
      step: 'Send receipt',
      sentence: 'retry scheduled in 30.0 s · attempt 2',
      tone: 'waiting',
      rawType: 'node.retry_scheduled',
    });
    expect(humanizeDefinitionKey('core.http_request')).toBe('Http request');
  });
});
