import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  activeRuns,
  delay,
  waitForRunsToEnd,
  type RunFacts,
} from '../../support/recovery/facts.js';
import { nextStep, startFlow } from '../../support/recovery/flows.js';
import {
  pauseQueue,
  waitForAggregatePublished,
  waitForReadyAttempts,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const LIST_MS = 5_000;

type GivenUp = Readonly<{
  id: string;
  failed_at: Date | null;
  last_error_code: string | null;
}>;

/**
 * Giving up on a job is the end of asking, not the end of the run. A run job can't
 * be left failed the way a mail job can, because the run would wait on it for good,
 * so a new one is built from the run. Nothing else moves a queued run or a ready
 * step, so without this a day of a lost job would become a run stuck forever.
 */
describeFaults('a run job given up on after a day of redeliveries', () => {
  let stack: Stack;
  let workspace: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let firstJob: GivenUp | undefined;
  let attemptJob: GivenUp | undefined;
  let active: number;
  let list: string;
  const runs: Record<string, string> = {};

  // What a day of asking comes to: every copy lost, and the limit reached.
  const askedForADay = (jobName: string, runId: string): Promise<unknown> =>
    stack.sql(
      `update app.outbox_events
          set redeliveries=30, delivery_due_at=clock_timestamp()
        where job_name=$1 and (aggregate_id=$2 or payload->>'runId'=$2::text)`,
      [jobName, runId],
    );

  const givenUp = async (
    jobName: string,
    runId: string,
  ): Promise<GivenUp | undefined> =>
    (
      await stack.sql<GivenUp>(
        `select id, failed_at, last_error_code from app.outbox_events
          where job_name=$1 and (aggregate_id=$2 or payload->>'runId'=$2::text)
          order by created_at limit 1`,
        [jobName, runId],
      )
    )[0];

  beforeAll(async () => {
    stack = await startStack('run-job-given-up');
    workspace = await stack.api.createWorkspace('recovery-given-up');

    await pauseQueue(stack, QUEUE_NAME.workflowCoordinator);
    runs.first = await startFlow(stack, workspace, 'first', [
      nextStep(stack, 'given-up-first'),
    ]);
    await waitForAggregatePublished(stack, runs.first, 1);
    await stack.flushRedis();
    await askedForADay('advance-workflow-run', runs.first);
    facts = await waitForRunsToEnd(stack, [runs.first], RECOVERY_LIMIT_MS);

    await pauseQueue(stack, QUEUE_NAME.nodeAttempts);
    runs.attempt = await startFlow(stack, workspace, 'attempt', [
      nextStep(stack, 'given-up-attempt'),
    ]);
    await waitForReadyAttempts(stack, [runs.attempt], 1);
    await delay(1_000);
    await stack.flushRedis();
    await askedForADay('execute-node-attempt', runs.attempt);
    facts = {
      ...facts,
      ...(await waitForRunsToEnd(stack, [runs.attempt], RECOVERY_LIMIT_MS)),
    };

    firstJob = await givenUp('advance-workflow-run', runs.first);
    attemptJob = await givenUp('execute-node-attempt', runs.attempt);
    active = await activeRuns(stack, workspace);

    const operator = stack.operator({
      OPERATOR_COMMAND_TYPE: 'stuck-work.list',
    });
    operator.startOnce();
    await delay(LIST_MS);
    await operator.stop('SIGKILL');
    list = operator.logs.map(({ text }) => text).join('\n');
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('still runs a run whose first job was given up on, once', () => {
    expect(facts[runs.first ?? '']?.status).toBe('succeeded');
    expect(stack.sink.calls('given-up-first')).toHaveLength(1);
  });

  it('still runs a step whose job was given up on, once', () => {
    expect(facts[runs.attempt ?? '']?.status).toBe('succeeded');
    expect(stack.sink.calls('given-up-attempt')).toHaveLength(1);
  });

  it('keeps no capacity for the job it gave up on', () => {
    expect(active).toBe(0);
  });

  it('says what it gave up on, where an operator looks', () => {
    for (const job of [firstJob, attemptJob]) {
      expect(job?.failed_at).not.toBeNull();
      expect(job?.last_error_code).toBe('delivery.never_confirmed');
      expect(list).toContain(job?.id);
    }
    expect(
      stack.worker.linesMentioning(['run_recovery.delivery_given_up'], 'warn'),
    ).toHaveLength(2);
  });
});
