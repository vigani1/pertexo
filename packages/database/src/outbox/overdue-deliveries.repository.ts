import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../platform/query-errors.js';
import { inboxReceipts, outboxEvents } from '../schema/transport.js';
import { DELIVERY_CONSUMER } from './delivery-consumers.js';
import { RUN_DELIVERY_JOB_NAMES } from './dispatcher/repository.js';

/** About a day of redeliveries, once the delay reaches its ceiling. */
const MAXIMUM_REDELIVERIES = 30;

const receiptExists = sql`exists(
  select 1 from ${inboxReceipts} r
   where r.consumer_name in ${Object.values(DELIVERY_CONSUMER)}
     and r.message_id = e.id
)`;

/** A job asked for again, or given up on after {@link MAXIMUM_REDELIVERIES}. */
export type OverdueDelivery = Readonly<{
  workspaceId: string;
  outboxEventId: string;
  jobName: string;
  aggregateId: string;
  redeliveries: number;
  gaveUp: boolean;
}>;

/**
 * Settles a batch of published jobs past their time, in one statement: a receipt
 * ends the row's watch, and without one the same row goes back to the dispatcher.
 * No run lock and no decision per kind: what a repeat means is its consumer's to
 * decide under its own locks, as it does for every BullMQ retry of this event.
 */
export async function settleOverdueDeliveries(
  pool: Pool,
  limit: number,
): Promise<Readonly<{ settled: number; asked: readonly OverdueDelivery[] }>> {
  const result = await drizzle(pool)
    .execute<OverdueDelivery & Readonly<{ confirmed: boolean }>>(
      sql`
      with due as materialized (
        select e.id, ${receiptExists} as confirmed,
               e.redeliveries >= ${MAXIMUM_REDELIVERIES} as exhausted
          from ${outboxEvents} e
         where e.delivery_due_at <= clock_timestamp() and e.failed_at is null
         order by e.delivery_due_at, e.id
         limit ${limit}
         for update of e skip locked
      ), settled as (
        update ${outboxEvents} e set
          published_at = case when due.confirmed then e.published_at end,
          failed_at = case when not due.confirmed and due.exhausted then clock_timestamp() end,
          last_error_code = case when not due.confirmed and due.exhausted
            then 'delivery.never_confirmed' else e.last_error_code end,
          available_at = case when due.confirmed then e.available_at else clock_timestamp() end,
          redeliveries = case when due.confirmed or due.exhausted then e.redeliveries else e.redeliveries + 1 end,
          -- A run must not wait on a row given up on; see the failed rows below.
          delivery_due_at = case when not due.confirmed and due.exhausted
            and e.job_name in ${RUN_DELIVERY_JOB_NAMES} then clock_timestamp() end,
          updated_at = clock_timestamp()
          from due where e.id = due.id
        returning e.id, e.workspace_id, e.job_name, e.aggregate_id, e.redeliveries,
                  due.confirmed, not due.confirmed and due.exhausted as gave_up
      )
      select id as "outboxEventId", workspace_id as "workspaceId", job_name as "jobName",
             aggregate_id as "aggregateId", redeliveries, confirmed, gave_up as "gaveUp",
             case when gave_up then app.release_dispatcher_workflow_run_active_admission(workspace_id, id) end
        from settled`,
    )
    .catch(rethrowQueryFailure);
  return Object.freeze({
    settled: result.rows.length,
    asked: result.rows.filter(({ confirmed }) => !confirmed),
  });
}

/**
 * A row published before due times existed, and lost around the upgrade, has the
 * shape of none other: everything since is dated when published, and loses the
 * date only for a receipt or a failure. Returns how many it dated, for the caller
 * to go on until there are none.
 */
export async function dateUndatedDeliveries(
  pool: Pool,
  limit: number,
): Promise<number> {
  const result = await drizzle(pool)
    .execute(
      sql`
      with undated as materialized (
        select e.id from ${outboxEvents} e
         where e.published_at is not null and e.delivery_due_at is null
           and e.failed_at is null and not ${receiptExists}
         limit ${limit}
         for update of e skip locked
      )
      update ${outboxEvents} e
         set delivery_due_at = clock_timestamp(), updated_at = clock_timestamp()
        from undated where e.id = undated.id`,
    )
    .catch(rethrowQueryFailure);
  return result.rowCount ?? 0;
}
