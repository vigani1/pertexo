import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay } from '../../support/recovery/facts.js';
import { heldStep, nextStep } from '../../support/recovery/flows.js';
import { httpChain } from '../../support/recovery/graphs.js';
import {
  pauseQueue,
  queuedJobs,
  waitForPublished,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const ENDED = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

// "Test this step" waits on the page for an answer, so a preview that never ends
// is a spinner that never stops, on a draft the user is trying to fix.
describeFaults('step tests whose jobs were lost', () => {
  let stack: Stack;
  let workspace: string;
  let jobsLeftInRedis: number;
  const previews: Record<string, string> = {};
  const seen: Record<string, string> = {};

  const test = async (name: string, id: string, held: boolean) => {
    const draft = await stack.api.saveDraft(
      workspace,
      name,
      httpChain([held ? heldStep(stack, id, 'POST') : nextStep(stack, id)]),
    );
    previews[name] = await stack.api.testStep(
      workspace,
      draft,
      held ? 'held' : 'next',
    );
  };

  /** Waits for these tests to end, up to the limit, and keeps what they show. */
  const waitForEnds = async (names: readonly string[]) => {
    const deadline = Date.now() + RECOVERY_LIMIT_MS;
    for (;;) {
      for (const name of names)
        seen[name] = await stack.api.readPreview(
          workspace,
          previews[name] ?? '',
        );
      const allEnded = names.every((name) => ENDED.has(seen[name] ?? ''));
      if (allEnded || Date.now() > deadline) return;
      await delay(500);
    }
  };

  beforeAll(async () => {
    stack = await startStack('lost-previews');
    workspace = await stack.api.createWorkspace('recovery-previews');

    // Nothing wrong: the fixture works, and it finishes before anything is lost.
    await test('finished', 'finished', false);
    await waitForEnds(['finished']);

    // A lost run-it job: the test is queued and nothing will take it.
    await pauseQueue(stack, QUEUE_NAME.nodeAttempts);
    await test('neverStarted', 'never-started', false);
    await waitForPublished(stack, { 'execute-preview-attempt': 2 });
    await stack.flushRedis();

    // A lost look-again job. A worker dies holding a POST; the job that would have
    // settled it comes due when the lease ends, and that job is what Redis loses.
    await pauseQueue(stack, QUEUE_NAME.maintenance);
    await test('orphaned', 'orphaned', true);
    await stack.sink.waitForCalls('orphaned', 1, DISPATCH_LIMIT_MS);
    await stack.worker.stop('SIGKILL');
    stack.worker.start();
    await stack.worker.waitForLog(/worker\.started/u, DISPATCH_LIMIT_MS * 4);
    const [reconcile] = await stack.sql<{ pending: number }>(
      `select count(*)::int as pending from app.outbox_events
        where job_name='reconcile-preview-attempt'`,
    );
    await waitForPublished(stack, {
      'reconcile-preview-attempt': reconcile?.pending ?? 1,
    });
    await stack.flushRedis();
    jobsLeftInRedis = await queuedJobs(stack, QUEUE_NAME.maintenance);

    await waitForEnds(['finished', 'neverStarted', 'orphaned']);

    // The same death with nothing lost: this is how `orphaned` should have ended.
    await test('settled', 'settled', true);
    await stack.sink.waitForCalls('settled', 1, DISPATCH_LIMIT_MS);
    await stack.worker.stop('SIGKILL');
    stack.worker.start();
    await waitForEnds(['settled']);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('really lost the jobs', () => {
    expect(jobsLeftInRedis).toBe(0);
  });

  // A finished test's look-again job has nothing left to do, so it is safe to lose.
  it('keeps the result of a test that had finished', () => {
    expect(seen.finished).toBe('succeeded');
    expect(stack.sink.calls('finished')).toHaveLength(1);
  });

  it('settles a test whose worker died, when nothing is lost', () => {
    expect(seen.settled).toBe('outcome_unknown');
    expect(stack.sink.calls('settled')).toHaveLength(1);
  });

  it('runs a test whose job was lost, once', () => {
    expect(seen.neverStarted).toBe('succeeded');
    expect(stack.sink.calls('never-started')).toHaveLength(1);
  });

  it('settles a test whose worker died and whose job was lost', () => {
    expect(seen.orphaned).toBe('outcome_unknown');
    expect(stack.sink.calls('orphaned')).toHaveLength(1);
  });
});
