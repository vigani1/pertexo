// @vitest-environment node
import {
  describeRunSentence,
  runEnding,
} from '@/features/workflow-runs/model/presentation/run-sentence';

import { storyEntryReason } from '@/features/workflow-runs/model/step-inspection/copy';

import { describeStepError } from '@/features/workflow-runs/model/step-inspection/error-copy';

import { describeRunEvent } from '@/features/workflow-runs/model/timeline/event-copy';

import { buildRunTimeline } from '@/features/workflow-runs/model/timeline/runs';

import { replayStep } from '@/features/workflow-runs/model/timeline/step-replay';

import type { WorkflowRunEvent } from '@pertexo/contracts';

import { describe, expect, it } from 'vitest';

import {
  at,
  eventSequence,
  graph,
  node,
  nodeEvent,
  runSummary,
  start,
  stop,
} from './fixture';

describe('run copy', () => {
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
    eventSequence.value = 0;
    const line = describeRunEvent(
      nodeEvent('node.retry_scheduled', 5, { dueAt: at(35), attemptNumber: 2 }),
      start,
      () => 'Send receipt',
    );
    expect(line).toMatchObject({
      offset: '+5s',
      step: 'Send receipt',
      sentence: 'retry scheduled in 30s · attempt 2',
      tone: 'waiting',
      rawType: 'node.retry_scheduled',
    });
  });
});

describe('a Wait step', () => {
  it('stays one attempt across its pause and spans the whole wait', () => {
    const replay = replayStep(
      [
        nodeEvent('node.started', 1, { attemptNumber: 1 }),
        nodeEvent('node.waiting', 1.02, { dueAt: at(91) }),
        nodeEvent('node.started', 91, { attemptNumber: 2 }),
        nodeEvent('node.succeeded', 91.03, { attemptNumber: 2 }),
      ],
      node('send-receipt', 'succeeded', {
        currentAttemptNumber: 2,
        completedAt: at(91.03),
      }),
      Date.parse(at(92)),
    );
    expect(replay.attempts).toBe(1);
    const attempts = replay.story.filter((entry) => entry.kind === 'attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'succeeded',
      startedAt: at(1),
      endedAt: at(91.03),
    });
  });
  it('names each run of a step inside a loop by the item it ran for', () => {
    const key = (ordinals: string) =>
      `v1|charge|b:|i:${encodeURIComponent(ordinals)}`;
    const view = buildRunTimeline({
      run: runSummary('succeeded', { completedAt: at(9) }),
      nodes: [
        node('charge', 'succeeded', {
          id: '11111111-1111-4111-8111-111111111101',
          invocationKey: key('each:0'),
        }),
        node('charge', 'succeeded', {
          id: '11111111-1111-4111-8111-111111111102',
          invocationKey: key('each:2'),
          startedAt: at(2),
        }),
        node('charge', 'succeeded', {
          id: '11111111-1111-4111-8111-111111111103',
          invocationKey: key('outer:1/each:4'),
          startedAt: at(3),
        }),
      ],
      events: [],
      nowMs: start + 10_000,
    });
    expect(view.rows.map((row) => row.label)).toEqual([
      'charge · item 1',
      'charge · item 3',
      'charge · item 2 › 5',
    ]);
  });
  it('says why a step ended the way it did', () => {
    const entry = {
      id: 'event-1:attempt',
      kind: 'attempt' as const,
      outcome: 'failed' as const,
      tone: 'failure' as const,
      startedAt: at(1),
    };
    expect(storyEntryReason(entry)).toBeUndefined();
    expect(
      storyEntryReason({ ...entry, reasonCode: 'network', attemptNumber: 1 }),
    ).toBe('Not retried: this step doesn’t retry this kind of failure.');
    expect(
      storyEntryReason({ ...entry, reasonCode: 'network', attemptNumber: 3 }),
    ).toBe('Pertexo stopped retrying after attempt 3.');
    expect(
      storyEntryReason({ ...entry, reasonCode: 'unsafe_possible_dispatch' }),
    ).toMatch(/may already have reached the service/u);
    expect(
      storyEntryReason({
        ...entry,
        kind: 'skipped',
        outcome: 'skipped',
        reasonCode: 'branch_failed',
      }),
    ).toBe('It didn’t start: a branch it waits for failed.');
    expect(
      storyEntryReason({ ...entry, reasonCode: 'canceled' }),
    ).toBeUndefined();
  });
  it('keeps the reason a failure event gives on the story', () => {
    const replay = replayStep(
      [
        nodeEvent('node.started', 1, { nodeId: 'charge', attemptNumber: 1 }),
        nodeEvent('node.failed', 2, {
          nodeId: 'charge',
          attemptNumber: 1,
          safeErrorCode: 'provider.timeout',
          reasonCode: 'timeout',
        }),
      ],
      undefined,
      start + 2_000,
    );
    expect(replay.story.at(-1)).toMatchObject({
      outcome: 'failed',
      safeErrorCode: 'provider.timeout',
      reasonCode: 'timeout',
    });
  });
});

describe('reused prefix history', () => {
  it('does not turn owned copies into attempts or duration segments, with or without retained events', () => {
    const summary = node('copied', 'succeeded', {
      currentAttemptNumber: 0,
      startedAt: null,
      completedAt: null,
      reused: {
        sourceRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceNodeRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sourceCompletedAt: at(-60),
      },
    });
    const reused: WorkflowRunEvent = {
      sequence: 2,
      type: 'node.reused',
      createdAt: at(0),
      payload: {
        nodeId: summary.nodeId,
        invocationKey: summary.invocationKey,
        nodeRunId: summary.id,
        outputRef: { kind: 'reused', nodeRunId: summary.id },
        ...summary.reused,
      },
    };
    for (const events of [[], [reused]])
      expect(replayStep(events, summary, start + 1000)).toMatchObject({
        segments: [],
        story: [],
        attempts: 0,
        status: 'succeeded',
      });
    expect(describeRunEvent(reused, start, () => 'Copied')).toMatchObject({
      sentence: 'reused · not executed again',
      tone: 'success',
    });
  });
});

describe('handled failure history', () => {
  it('keeps the failed glyph and handles only recorded completion', () => {
    const done = runSummary('succeeded', {
      completedAt: at(5),
      handledFailureCount: 1,
    });
    const source = node('source', 'failed', {
      failureHandling: {
        entryInvocationKey: 'handler:0',
        sinkInvocationKey: 'sink:0',
        disposition: 'handled',
      },
      completedAt: at(2),
    });
    const view = buildRunTimeline({
      run: done,
      nodes: [source],
      events: [],
      nowMs: start + 6_000,
    });
    expect(view.rows[0]).toMatchObject({
      status: 'failed',
      tone: 'failure',
      statusLabel: 'Failed · failure handled',
    });
    expect(describeRunSentence(done, view.rows, start + 6_000)).toBe(
      'Finished — 1 failure handled',
    );
  });
  it('does not call an unfinished handler handled after the run stops', () => {
    const source = node('source', 'failed', {
      failureHandling: {
        entryInvocationKey: 'handler:0',
        sinkInvocationKey: 'sink:0',
        disposition: 'pending',
      },
      completedAt: at(2),
    });
    const active = buildRunTimeline({
      run: runSummary('waiting'),
      nodes: [source],
      events: [],
      nowMs: start + 6_000,
    });
    expect(active.rows[0]).toMatchObject({
      statusLabel: 'Failed · handling failure…',
      handlingInProgress: true,
    });
    const stopped = buildRunTimeline({
      run: runSummary('canceled', { completedAt: at(5) }),
      nodes: [source],
      events: [],
      nowMs: start + 6_000,
    });
    expect(stopped.rows[0]?.statusLabel).toBe('Failed · not handled');
    expect(stopped.rows[0]?.handlingInProgress).toBeUndefined();
  });
  it('does not blame a handled source when the run fails later', () => {
    const run = runSummary('failed', {
      completedAt: at(8),
      handledFailureCount: 1,
    });
    const timeline = buildRunTimeline({
      run,
      graph,
      nodes: [
        node('post-erp', 'failed', {
          failureHandling: {
            entryInvocationKey: 'handler:0',
            sinkInvocationKey: 'handler:0',
            disposition: 'handled',
          },
        }),
      ],
      events: [],
      nowMs: start + 8000,
    });
    expect(describeRunSentence(run, timeline.rows, start + 8000)).toBe(
      'Failed after 8s',
    );
  });
  it('retains a handled-success explanation without claiming missing step evidence', () => {
    const done = runSummary('succeeded', {
      completedAt: at(5),
      handledFailureCount: 1,
    });
    expect(describeRunSentence(done, [], start + 40_000_000)).toBe(
      'Finished — 1 failure handled',
    );
  });
});

describe('a run’s ending', () => {
  it('names the fixed outcome of the Stop run step that finished the run', () => {
    const graph =
      /* The sentence presenter reads only these Stop run nodes; graph execution fields are intentionally absent. */ {
        nodes: [stop('accepted', 'accepted'), stop('rejected', 'rejected')],
      } as unknown as Parameters<typeof runEnding>[1];
    expect(
      runEnding(
        [
          {
            nodeId: 'accepted',
            definitionKey: 'core.terminate',
            status: 'skipped',
          },
          {
            nodeId: 'rejected',
            definitionKey: 'core.terminate',
            status: 'succeeded',
          },
        ],
        graph,
      ),
    ).toBe('rejected');
  });
});
