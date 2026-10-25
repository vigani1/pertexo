// @vitest-environment node
import { describeRunSentence } from '@/features/workflow-runs/model/presentation/run-sentence';

import { stepTag } from '@/features/workflow-runs/model/step-inspection/copy';

import { describeRunEvent } from '@/features/workflow-runs/model/timeline/event-copy';

import { segmentPlacement } from '@/features/workflow-runs/model/timeline/geometry';

import { buildRunTimeline } from '@/features/workflow-runs/model/timeline/runs';

import { describe, expect, it } from 'vitest';

import {
  at,
  eventSequence,
  graph,
  node,
  nodeEvent,
  runSummary,
  start,
} from './timeline/fixture';

describe('thread view', () => {
  it('names invoked nested loop steps without listing unrun body steps as pending roots', () => {
    eventSequence.value = 0;
    const nestedGraph =
      /* This focused graph fixture supplies the node/edge metadata read by the presenter; executable-only fields are omitted. */ {
        settings: {},
        edges: [],
        nodes: [
          {
            id: 'outer',
            label: 'Outer pair',
            definition: { key: 'core.foreach', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 2,
              maxConcurrency: 1,
              body: {
                settings: {},
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                edges: [],
                nodes: [
                  {
                    id: 'inner',
                    label: 'Inner pair',
                    definition: { key: 'core.foreach', version: 1 },
                    position: { x: 0, y: 0 },
                    configVersion: 1,
                    config: {},
                    inputMappings: {},
                    connectionRefs: {},
                    structured: {
                      kind: 'for_each',
                      maxIterations: 2,
                      maxConcurrency: 1,
                      body: {
                        settings: {},
                        inputPorts: ['item', 'ordinal'],
                        outputPorts: ['result'],
                        edges: [],
                        nodes: [
                          {
                            id: 'leaf',
                            label: 'Nested receipt',
                            definition: { key: 'core.set', version: 1 },
                            position: { x: 0, y: 0 },
                            configVersion: 1,
                            config: {},
                            inputMappings: {},
                            connectionRefs: {},
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      } as unknown as NonNullable<
        Parameters<typeof buildRunTimeline>[0]['graph']
      >;
    const event = nodeEvent('node.succeeded', 2, {
      nodeId: 'inner',
      invocationKey: 'inner:outer:0',
    });
    const view = buildRunTimeline({
      run: runSummary('running'),
      nodes: [
        node('outer', 'waiting'),
        node('inner', 'succeeded', {
          invocationKey: 'inner:outer:0',
          completedAt: at(2),
        }),
      ],
      events: [event],
      graph: nestedGraph,
      nowMs: start + 3_000,
    });

    expect(view.rows.map((row) => row.label)).toEqual([
      'Outer pair',
      'Inner pair',
    ]);
    expect(view.rows[1]?.kindLabel).toBe('For each');
    expect(
      describeRunEvent(
        event,
        start,
        () => view.rows.find((row) => row.nodeId === 'inner')?.label,
      ).step,
    ).toBe('Inner pair');
  });
  it('turns attempts, a scheduled retry and a running attempt into one row', () => {
    eventSequence.value = 0;
    const events = [
      nodeEvent('node.started', 4, { attemptNumber: 1 }),
      nodeEvent('node.retry_scheduled', 5, {
        attemptNumber: 1,
        dueAt: at(35),
        safeErrorCode: 'provider.unavailable',
      }),
      nodeEvent('node.started', 35, { attemptNumber: 2 }),
    ];
    const view = buildRunTimeline({
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
    // Step types read the way Build names them.
    expect(view.rows.map((row) => row.kindLabel)).toEqual([
      'HTTP request',
      'Send email',
      undefined,
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
    // Each entry is named by the event that made it: unique, and the same
    // for as long as later events keep arriving.
    const ids = receipt?.story.map((entry) => entry.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^event-\d+:(attempt|retry)$/u.test(id))).toBe(
      true,
    );
    expect(receipt?.story[0]?.safeErrorCode).toBe('provider.unavailable');
    expect(receipt?.story[1]?.endedAt).toBe(at(35));
    expect(done?.status).toBe('not_started');
    expect(done?.segments[0]).toMatchObject({ kind: 'pending', endMs: null });
    if (receipt === undefined) throw new Error('Missing Send receipt row');
    expect(stepTag(receipt, start + 47_000)).toBe('attempt 2');
    expect(view.ticks[0]).toEqual({ offsetMs: 0, label: '0' });
  });
  it('names the retrying step in the run sentence and counts down the wait', () => {
    eventSequence.value = 0;
    const nowMs = start + 20_000;
    const view = buildRunTimeline({
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
      'retry in 15s',
    );
    expect(view.endMs).toBe(start + 35_000);
  });
  it('falls back to node summaries when events are gone', () => {
    const view = buildRunTimeline({
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
  it('marks steps that use a connection and carries each node run’s attempt', () => {
    const [post, receipt] = graph.nodes;
    if (post === undefined || receipt === undefined)
      throw new Error('fixture graph is missing');
    const view = buildRunTimeline({
      run: runSummary('running'),
      nodes: [node('send-receipt', 'running', { currentAttemptNumber: 2 })],
      events: [],
      graph: {
        ...graph,
        nodes: [
          post,
          {
            ...receipt,
            connectionRefs: { email: '88888888-8888-4888-8888-888888888888' },
          },
        ],
      },
      nowMs: start + 60_000,
    });
    const byLabel = new Map(view.rows.map((row) => [row.label, row]));
    expect(byLabel.get('Send receipt')).toMatchObject({
      usesConnection: true,
      currentAttemptNumber: 2,
    });
    expect(byLabel.get('Post to ERP')?.usesConnection).toBeUndefined();
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
    expect(describeRunSentence(done, [], start)).toBe('Succeeded in 4.2s');
    expect(describeRunSentence(done, [], start, 'rejected')).toBe(
      'Succeeded as “rejected” in 4.2s',
    );
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
});
