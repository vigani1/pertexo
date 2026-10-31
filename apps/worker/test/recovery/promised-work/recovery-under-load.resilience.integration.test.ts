import { QUEUE_NAME } from '@pertexo/queue';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../../support/recovery/facts.js';
import { nextStep, startFlow } from '../../support/recovery/flows.js';
import {
  pauseQueue,
  waitForPublished,
  waitForReadyAttempts,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const DELIVERED_JOBS = 2_000;

/**
 * Every delivered run job keeps its due time until the scanner clears it, and the
 * scanner takes 50 rows every 5 s, oldest first: about 10 jobs a second. A busy
 * install delivers more than that, so the rows ahead of a lost job only grow.
 * Here they are a backlog of 2,000 confirmed jobs already overdue when a job is
 * lost, about what a few minutes of a busy worker leaves behind.
 */
describeFaults('a job lost behind a backlog of delivered jobs', () => {
  let stack: Stack;
  let facts: Readonly<Record<string, RunFacts>>;
  const runs: Record<string, string> = {};

  beforeAll(async () => {
    stack = await startStack('recovery-under-load');
    const workspace = await stack.api.createWorkspace('recovery-under-load');
    await stack.sql(
      `with delivered as (
         select gen_random_uuid() as id, n
           from generate_series(1, $2::int) n
       ), events as (
         insert into app.outbox_events
           (id, workspace_id, job_name, aggregate_type, aggregate_id, payload,
            payload_checksum, published_at, delivery_due_at)
         select id, $1::uuid, 'advance-workflow-run', 'workflow-run', $3::uuid,
                '{}'::jsonb, repeat('0', 64), clock_timestamp(),
                clock_timestamp() - make_interval(secs => n)
           from delivered
         returning id
       )
       insert into app.inbox_receipts
         (consumer_name, message_id, workspace_id, payload_checksum, completed_at)
       select 'workflow-coordinator', id, $1::uuid, repeat('0', 64), clock_timestamp()
         from events`,
      [workspace, DELIVERED_JOBS, randomUUID()],
    );

    await pauseQueue(stack, QUEUE_NAME.nodeAttempts);
    runs.lost = await startFlow(stack, workspace, 'lost', [
      nextStep(stack, 'lost-behind-backlog'),
    ]);
    await waitForReadyAttempts(stack, [runs.lost], 1);
    await waitForPublished(stack, { 'execute-node-attempt': 1 });
    await stack.flushRedis();

    facts = await waitForRunsToEnd(stack, [runs.lost], RECOVERY_LIMIT_MS);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('still recovers the lost job within the recovery limit', () => {
    expect(factsOfRun(facts, runs, 'lost').status).toBe('succeeded');
    expect(stack.sink.calls('lost-behind-backlog')).toHaveLength(1);
  });
});
