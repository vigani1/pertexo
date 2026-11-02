import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeWorkspaceLifecycle } from '../../../src/lifecycle/deletion/change.js';
import {
  WebhookDeliveryIneligibleError,
  WebhookWorkflowPausedError,
} from '../../../src/triggers/webhooks/errors.js';
import {
  actorId,
  afterAllFixture2,
  beforeAllFixture1,
  hash,
  ownerQuery,
  publishNextTriggerWorkflowVersion,
  secret,
  webhook,
  workspaceId,
} from './fixture.js';
import {
  acceptedScenario,
  apiPool,
  closePools,
  closesAs,
  COMMANDS,
  delivery,
  holders,
  openPools,
  touchedOneRow,
  type Scenario,
} from './ingress/admission-scenario.js';
import { sqlStates } from './ingress/lock-holder.js';

beforeAll(async () => {
  await beforeAllFixture1();
  openPools();
}, 60_000);

afterAll(async () => {
  await closePools();
  await afterAllFixture2();
});

describe('admission against the commands that close it', () => {
  const lifecycle = (commandType: 'deletion_requested') =>
    changeWorkspaceLifecycle(apiPool, {
      operationId: randomUUID(),
      workspaceId,
      actorUserId: actorId,
      commandType,
      reason: 'deadlock attempt',
      idempotencyKeyHash: hash(randomUUID()),
      requestHash: hash(randomUUID()),
    });
  const restore = () =>
    ownerQuery(
      `update app.workspaces set status='active',deletion_requested_at=null,
         deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
      [workspaceId],
    );

  const RACERS = [
    ...COMMANDS,
    {
      name: 'rotating the secret',
      run: ({ verification, resources }: Scenario) =>
        webhook.rotateSecret({
          workspaceId,
          actorId,
          workflowId: verification.workflowId,
          triggerId: resources.webhookId,
          endpointKeyHash: verification.endpointKeyHash,
          secret: secret(),
          idempotencyKey: randomUUID(),
          requestHash: hash(randomUUID()),
        }),
    },
    {
      name: 'publishing',
      run: ({ verification }: Scenario) =>
        publishNextTriggerWorkflowVersion(verification.workflowId),
    },
    {
      name: 'pausing',
      run: ({ verification, firstRunId }: Scenario & { firstRunId?: string }) =>
        ownerQuery(
          `update app.workflows
              set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
                  trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
                  trigger_pause_last_run_id=$2,trigger_pause_revision=trigger_pause_revision+1
            where id=$1`,
          [verification.workflowId, firstRunId],
        ),
    },
    {
      name: 'requesting workspace deletion',
      run: () => lifecycle('deletion_requested'),
      undo: restore,
    },
  ] as const;

  const HELD_ROWS = [
    [
      'the endpoint',
      'select 1 from app.webhook_trigger_endpoints where id=$1 for update',
      ({ verification }: Scenario) => [verification.endpointId],
      true,
    ],
    [
      'the workflow',
      'select 1 from app.workflows where id=$1 for update',
      ({ verification }: Scenario) => [verification.workflowId],
      false,
    ],
    [
      'the workspace',
      'select 1 from app.workspaces where id=$1 for update',
      () => [workspaceId],
      false,
    ],
    [
      'the admission counters',
      'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update',
      () => [workspaceId],
      false,
    ],
  ] as const;

  const cases = RACERS.flatMap((racer) =>
    HELD_ROWS.map(([row, statement, parameters, asApp]) => ({
      name: racer.name,
      row,
      racer,
      statement,
      parameters,
      asApp,
    })),
  );

  const deadlocks = async () => {
    // Postgres publishes the counter when a backend goes idle.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const { rows } = await holders.query<{ deadlocks: string }>(
      'select deadlocks from pg_stat_database where datname=current_database()',
    );
    return Number(rows[0]?.deadlocks);
  };

  it.each(cases)(
    'never deadlocks with $name when both queue up behind $row',
    async ({ asApp, racer, statement, parameters }) => {
      const scenario = await acceptedScenario();
      const holder = await closesAs(asApp);
      try {
        touchedOneRow(await holder.query(statement, [...parameters(scenario)]));
        const deliveries = Array.from({ length: 3 }, (_, at) =>
          webhook.acceptVerifiedDelivery(
            delivery(scenario, `${String(at)}-${randomUUID()}`),
          ),
        );
        // Deliveries first, so they hold what they got when the command arrives.
        await expect
          .poll(async () => (await holder.waiters()).length > 0, {
            timeout: 10_000,
            interval: 10,
          })
          .toBe(true);
        const settled = Promise.allSettled([
          ...deliveries,
          Promise.resolve().then((): Promise<unknown> => racer.run(scenario)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await holder.commit();
        const outcomes = await settled;
        const states = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? sqlStates(outcome.reason) : [],
        );
        expect(states).not.toContain('40P01');
        // A delivery either starts a run or is refused for a named reason.
        for (const outcome of outcomes.slice(0, deliveries.length))
          if (outcome.status === 'rejected')
            expect(
              outcome.reason instanceof WebhookDeliveryIneligibleError ||
                outcome.reason instanceof WebhookWorkflowPausedError,
              String(outcome.reason),
            ).toBe(true);
      } finally {
        await holder.rollback();
        if ('undo' in racer) await racer.undo();
      }
    },
    30_000,
  );

  it('records no deadlock in the whole database after all of that', async () => {
    expect(await deadlocks()).toBe(0);
  }, 10_000);
});
