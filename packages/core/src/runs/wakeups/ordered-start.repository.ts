import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/**
 * Called in the transaction that starts `runId`. A limited workflow's granted runs
 * start in ticket order, so a later one that tried first was deferred while still
 * holding its slot. Now that the run ahead of it has started, it needn't wait out
 * the deferral: its delivery becomes due at once. The deferral stays the fallback
 * when the run ahead is stuck.
 *
 * Takes no lock it would wait for: a delivery the dispatcher holds is already due.
 */
export async function wakeNextOrderedStart(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`
        update app.outbox_events event
           set available_at=clock_timestamp(), updated_at=clock_timestamp()
         where event.id in (
           select deferred.id from app.outbox_events deferred
            where deferred.workspace_id=${workspaceId}
              and deferred.job_name='advance-workflow-run'
              and deferred.published_at is null and deferred.failed_at is null
              and deferred.lease_expires_at is null
              and deferred.available_at>clock_timestamp()
              and deferred.id=(
                -- Non-exempt grants exist only under a workflow limit.
                select admission.outbox_event_id
                  from app.workflow_run_active_admissions admission
                  join app.workflow_runs started
                    on started.workspace_id=admission.workspace_id and started.id=${runId}
                  join app.workflow_runs waiting
                    on waiting.workspace_id=admission.workspace_id and waiting.id=admission.workflow_run_id
                 where admission.workspace_id=${workspaceId}
                   and not admission.workflow_concurrency_order_exempt
                   and waiting.workflow_id=started.workflow_id
                   and waiting.status='queued' and waiting.cancel_requested_at is null
                   and (waiting.deadline_at is null or waiting.deadline_at>clock_timestamp())
                 order by waiting.admission_ticket
                 limit 1)
            for update skip locked)
      `,
    )
    .catch(rethrowQueryFailure);
}
