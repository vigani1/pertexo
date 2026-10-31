import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  delay,
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../../support/recovery/facts.js';
import { nextStep } from '../../support/recovery/flows.js';
import { triggeredChain } from '../../support/recovery/graphs.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import {
  waitForScheduleReady,
  waitForWebhookKeys,
} from '../../support/recovery/triggers.js';

// Later than the on-time window below, so a `skip` schedule has really missed it.
const LATE_BY_MS = 70_000;
const INTERVAL_MINUTES = 2;

/**
 * No worker at all when the event comes and the occurrence falls due, and a Redis
 * that has lost everything when one returns. Nothing ran and nothing was queued,
 * so only what Postgres recorded can bring the work back.
 */
describeFaults('events and occurrences that arrive with no worker', () => {
  let stack: Stack;
  let statuses: readonly number[];
  let facts: Readonly<Record<string, RunFacts>>;
  let coalesced: number;
  let debouncedRuns: number;
  let occurrences: Readonly<
    Record<string, readonly { disposition: string; has_run: boolean }[]>
  >;
  const runs: Record<string, string> = {};

  const schedule = (misfirePolicy: 'catch_up_once' | 'skip', id: string) =>
    triggeredChain(
      {
        key: 'core.schedule',
        config: {
          kind: 'interval',
          intervalMinutes: INTERVAL_MINUTES,
          misfirePolicy,
        },
      },
      [nextStep(stack, id)],
    );

  const occurrencesOf = (workflowId: string) =>
    stack.sql<{ disposition: string; has_run: boolean }>(
      `select o.disposition, o.workflow_run_id is not null as has_run
         from app.trigger_schedule_occurrences o
         join app.workflow_triggers t on t.id=o.trigger_id
        where t.workflow_id=$1
        order by o.scheduled_at`,
      [workflowId],
    );

  beforeAll(async () => {
    stack = await startStack('arrivals-worker-down', {
      workerEnvironment: { TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: '60' },
    });
    const workspace = await stack.api.createWorkspace('recovery-arrivals');
    const hooked = await stack.api.publish(
      workspace,
      'hooked',
      triggeredChain({ key: 'core.webhook' }, [nextStep(stack, 'hooked')]),
    );
    const debounced = await stack.api.publish(
      workspace,
      'debounced',
      triggeredChain(
        {
          key: 'core.webhook',
          config: {
            coordination: {
              mode: 'debounce',
              key: { kind: 'run_input', path: '$.customer' },
              quietSeconds: 1,
            },
          },
        },
        [nextStep(stack, 'debounced')],
      ),
    );
    const catchingUp = await stack.api.publish(
      workspace,
      'catching-up',
      schedule('catch_up_once', 'catching-up'),
    );
    const skipping = await stack.api.publish(
      workspace,
      'skipping',
      schedule('skip', 'skipping'),
    );
    const hookedKeys = await waitForWebhookKeys(stack, workspace, hooked);
    const debouncedKeys = await waitForWebhookKeys(stack, workspace, debounced);
    await waitForScheduleReady(stack, catchingUp);
    await waitForScheduleReady(stack, skipping);

    await stack.worker.stop('SIGKILL');

    const event = await stack.api.sendWebhook(hookedKeys, { order: 1 });
    runs.hooked = (event.json as { runId: string }).runId;
    const first = await stack.api.sendWebhook(debouncedKeys, {
      customer: 'a',
      order: 1,
    });
    const second = await stack.api.sendWebhook(debouncedKeys, {
      customer: 'a',
      order: 2,
    });
    statuses = [event.status, first.status, second.status];

    const [due] = await stack.sql<{ due: Date }>(
      `select max(s.next_fire_at) as due from app.trigger_schedules s
         join app.workflow_triggers t on t.id=s.trigger_id
        where t.workflow_id = any($1::uuid[])`,
      [[catchingUp, skipping]],
    );
    await delay(
      Math.max(0, new Date(due?.due ?? 0).getTime() - Date.now()) + LATE_BY_MS,
    );
    await stack.flushRedis();
    stack.worker.start();

    const deadline = Date.now() + RECOVERY_LIMIT_MS;
    for (;;) {
      const [catchUpOccurrence] = await occurrencesOf(catchingUp);
      const [debouncedRun] = await stack.sql<{ id: string }>(
        `select id from app.workflow_runs where workflow_id=$1`,
        [debounced],
      );
      if (catchUpOccurrence !== undefined && debouncedRun !== undefined) {
        const [row] = await stack.sql<{ workflow_run_id: string }>(
          `select o.workflow_run_id from app.trigger_schedule_occurrences o
             join app.workflow_triggers t on t.id=o.trigger_id
            where t.workflow_id=$1 order by o.scheduled_at limit 1`,
          [catchingUp],
        );
        runs.catchingUp = row?.workflow_run_id ?? '';
        runs.debounced = debouncedRun.id;
        break;
      }
      if (Date.now() > deadline)
        throw new Error('Nothing came back after the worker returned');
      await delay(250);
    }
    facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );
    const [events] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.trigger_coordinated_events
        where workflow_id=$1 and status='coalesced'`,
      [debounced],
    );
    coalesced = events?.count ?? 0;
    const [count] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.workflow_runs where workflow_id=$1`,
      [debounced],
    );
    debouncedRuns = count?.count ?? 0;
    occurrences = {
      catchingUp: await occurrencesOf(catchingUp),
      skipping: await occurrencesOf(skipping),
    };
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

  it('told each sender its event was accepted', () => {
    expect(statuses).toEqual([202, 202, 202]);
  });

  it('runs the event once a worker returns, once', () => {
    expect(factsOf('hooked').status).toBe('succeeded');
    expect(stack.sink.calls('hooked')).toHaveLength(1);
  });

  it('runs a debounced event once a worker returns, from the latest event', () => {
    expect(factsOf('debounced').status).toBe('succeeded');
    expect(debouncedRuns).toBe(1);
    expect(coalesced).toBe(1);
    expect(stack.sink.calls('debounced')).toHaveLength(1);
  });

  // ADR 014: only the latest missed occurrence runs, by design.
  it('catches up on the missed occurrence once', () => {
    expect(factsOf('catchingUp').status).toBe('succeeded');
    expect(occurrences.catchingUp?.[0]).toEqual({
      disposition: 'accepted',
      has_run: true,
    });
    expect(stack.sink.calls('catching-up')).toHaveLength(
      occurrences.catchingUp?.filter(({ has_run: hasRun }) => hasRun).length ??
        -1,
    );
  });

  // ADR 049: a `skip` schedule drops what it missed, which its owner chose, and it
  // says so in the history rather than silently.
  it('records the occurrence a skip schedule missed', () => {
    expect(occurrences.skipping?.[0]).toEqual({
      disposition: 'skipped',
      has_run: false,
    });
  });
});
