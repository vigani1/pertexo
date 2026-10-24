import { waitForApplicationLock } from '../../../support/postgres/lock-coordination.js';

import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import { withWorkspaceTransaction } from '../../../../src/tenant-access/transactions.js';

import { expect, it } from 'vitest';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { createErrorWorkflowStore } from '../../../../src/runs/error-workflows/repository.js';

import { parseDatabaseConfig } from '../../../../src/config.js';
import { withTenantScopedClient } from '../../../../src/tenant-access/transactions.js';
import { admin, insertHint } from '../../../lifecycle/calls/fixtures.js';

import { apiUrl } from '../../../lifecycle/retention.support.js';
import {
  pool,
  store,
  fixture,
  delivery,
  intent,
  fullQueue,
} from './fixture.js';

export function registerFencesWakeupUpdatesSameWorkspace(): void {
  it('fences wakeup updates to same-workspace error deliveries and leaves payloads immutable', async () => {
    const f = await fullQueue();
    await store.dispatch(await delivery(f));
    const next = await delivery(f);
    const otherJob = await insertHint(f.workspaceId, f.blocker);
    const other = await fixture();
    await other.produce();
    const otherDelivery = await delivery(other);
    await withTenantScopedClient(
      pool,
      { workspaceId: f.workspaceId },
      async (client) => {
        expect(
          (
            await client.query(
              'update app.outbox_events set available_at=clock_timestamp() where id=$1',
              [next.outboxEventId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await client.query(
              'update app.outbox_events set available_at=clock_timestamp() where id=$1',
              [otherDelivery.outboxEventId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await client.query(
              'update app.outbox_events set available_at=clock_timestamp() where id=$1',
              [otherJob],
            )
          ).rowCount,
        ).toBe(0);
      },
    );
    await expect(
      withTenantScopedClient(pool, { workspaceId: f.workspaceId }, (client) =>
        client.query(
          "update app.outbox_events set payload='{}'::jsonb where id=$1",
          [next.outboxEventId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a deadline that expires while admission waits for released capacity', async () => {
    const f = await fullQueue();
    await store.dispatch(await delivery(f));
    const next = await delivery(f);
    const connection = new URL(apiUrl);
    const application = `error-deadline-${crypto.randomUUID()}`;
    connection.searchParams.set('application_name', application);
    const waitingStore = createErrorWorkflowStore(
      parseDatabaseConfig({ connectionString: connection.toString(), max: 1 }),
      (version) => ({
        checkpoint: createCheckpoint({
          workflowVersionId: version.id,
          iterationBudget: 200,
          nextEventSequence: 2,
        }),
      }),
    );
    const holder = await pool.connect();
    let open = false;
    let delivered: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await holder.query('begin');
      open = true;
      await holder.query("select set_config('app.workspace_id',$1,true)", [
        f.workspaceId,
      ]);
      // Free capacity in an uncommitted transaction, keeping its counter fenced.
      await holder.query(
        "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
        [f.blocker],
      );
      await admin.query(
        "update app.run_error_workflow_intents set queue_wait_expires_at=clock_timestamp()+interval '2 seconds' where workspace_id=$1 and source_run_id=$2",
        [f.workspaceId, f.parentRunId],
      );
      delivered = Promise.allSettled([waitingStore.dispatch(next)]);
      await waitForApplicationLock(admin, application);
      await admin.query(
        'select pg_sleep(greatest(0,extract(epoch from queue_wait_expires_at-clock_timestamp()))+0.001) from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2',
        [f.workspaceId, f.parentRunId],
      );
      await holder.query('commit');
      open = false;
      expect(await delivered).toEqual([
        { status: 'fulfilled', value: undefined },
      ]);
      expect(await intent(f)).toMatchObject({
        status: 'refused',
        refusal_code: 'queue_full',
        accepted_run_id: null,
      });
    } finally {
      if (open) await holder.query('rollback');
      holder.release();
      if (delivered !== undefined) await delivered;
      await waitingStore.close();
    }
  });

  it('records a visible concurrency refusal once when an error-workflow target selects Skip', async () => {
    const f = await fixture();
    await withWorkspaceTransaction(pool, f.workspaceId, (tx) =>
      acceptWorkflowRun(tx, {
        workflowId: f.childWorkflowId,
        workflowVersionId: f.childVersionId,
        initialCheckpoint: createCheckpoint({
          workflowVersionId: f.childVersionId,
          iterationBudget: 200,
        }),
        keyHash: 'd'.repeat(64),
        requestHash: 'e'.repeat(64),
        operation: 'workflow.run.accept',
        scope: 'error-busy',
        triggerType: 'api',
      }),
    );
    await admin.query(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [f.workspaceId, f.childWorkflowId],
    );
    await f.produce();
    const input = await delivery(f);
    await Promise.all([store.dispatch(input), store.dispatch(input)]);
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'concurrency_limit',
      accepted_run_id: null,
    });
    expect(
      (
        await admin.query(
          `select metadata from app.usage_events where workspace_id=$1 and category='trigger.skipped'`,
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([
      {
        metadata: {
          triggerType: 'workflow_error',
          reason: 'concurrency_limit',
        },
      },
    ]);
    expect(
      (
        await admin.query(
          `select id from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'`,
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([]);
  });
}
