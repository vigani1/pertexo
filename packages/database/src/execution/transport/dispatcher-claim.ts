import type { Pool } from 'pg';
import { z } from 'zod';

import { claimQueryResultSchema, toLeasedEvent } from './dispatcher-rows.js';
import type { LeasedOutboxEvent } from './dispatcher-contracts.js';

const claimInputSchema = z.object({
  enabledJobNames: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u))
    .max(64)
    .refine((values) => new Set(values).size === values.length),
  leaseDurationMillis: z.number().int().min(1_000).max(300_000),
  leaseOwner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  leaseToken: z.uuid(),
  limit: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(1_000),
});

export type ClaimOutboxBatchInput = Readonly<
  Omit<z.input<typeof claimInputSchema>, 'enabledJobNames'> & {
    enabledJobNames: readonly string[];
  }
>;

export type ClaimOutboxBatchResult = Readonly<{
  events: readonly LeasedOutboxEvent[];
  /** Rows atomically terminalized because their publish-attempt ceiling was reached. */
  exhaustedCount: number;
}>;

export async function claimOutboxBatch(
  pool: Pool,
  input: ClaimOutboxBatchInput,
): Promise<ClaimOutboxBatchResult> {
  const parsed = claimInputSchema.parse({
    ...input,
    enabledJobNames: [...input.enabledJobNames],
  });
  if (parsed.enabledJobNames.length === 0) {
    return Object.freeze({ events: Object.freeze([]), exhaustedCount: 0 });
  }
  const client = await pool.connect();
  let transactionState: 'not_started' | 'open' | 'committing' | 'closed' =
    'not_started';
  let releaseError: true | undefined;
  try {
    await client.query('begin');
    transactionState = 'open';
    await client.query(
      `select app.recover_due_workflow_run_active_admissions(100)`,
    );
    const result = await client.query<Record<string, unknown>>(
      `
        with cursor_state as materialized (
          select last_workspace_id
          from app.outbox_fair_dispatch_cursor
          where singleton
          for update
        ), workspace_round as materialized (
          select eligible.workspace_id,
                 row_number() over (order by
                   case when cursor_state.last_workspace_id is null then 0
                        when eligible.workspace_id > cursor_state.last_workspace_id then 0
                        else 1 end,
                   eligible.workspace_id) as round_ordinal
          from (
            select distinct workspace_id
            from app.outbox_events
            where published_at is null
              and failed_at is null
              and job_name = any($5::varchar[])
              and available_at <= clock_timestamp()
              and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
          ) eligible
          cross join cursor_state
          order by
            case when cursor_state.last_workspace_id is null then 0
                 when eligible.workspace_id > cursor_state.last_workspace_id then 0
                 else 1 end,
            eligible.workspace_id
          limit $1
        ), candidates as materialized (
          select picked.id,picked.publish_attempts,picked.job_name,
                 picked.aggregate_type,picked.aggregate_id,
                 workspace_round.workspace_id,workspace_round.round_ordinal
          from workspace_round
          cross join lateral (
            select id,publish_attempts,job_name,aggregate_type,aggregate_id
            from app.outbox_events event
            where event.workspace_id=workspace_round.workspace_id
              and published_at is null
              and failed_at is null
              and job_name = any($5::varchar[])
              and available_at <= clock_timestamp()
              and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
              and (
                publish_attempts >= $6
                or job_name <> 'advance-workflow-run'
                or app.workflow_run_active_admission_eligible(
                     event.workspace_id,event.id,event.aggregate_id
                   )
              )
            order by available_at,id
            for update skip locked
            limit 1
          ) picked
        ), admitted as materialized (
          select candidates.*
          from candidates
          where candidates.publish_attempts >= $6
             or candidates.job_name <> 'advance-workflow-run'
             or app.reserve_workflow_run_active_admission(
                  candidates.workspace_id,candidates.id,candidates.aggregate_id
                )
        ), exhausted as (
          update app.outbox_events event
          set
            failed_at = clock_timestamp(),
            last_error_code = 'publish.attempts_exhausted',
            lease_owner = null,
            lease_token = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
          from admitted
          where event.id = admitted.id
            and admitted.publish_attempts >= $6
          returning event.id,event.workspace_id
        ), released_exhausted_admissions as (
          select app.release_dispatcher_workflow_run_active_admission(workspace_id,id)
          from exhausted
        ), cursor_updated as (
          update app.outbox_fair_dispatch_cursor cursor
          set last_workspace_id=(
                select workspace_id from workspace_round
                order by round_ordinal desc limit 1
              ),
              updated_at=clock_timestamp()
          where cursor.singleton and exists(select 1 from workspace_round)
          returning cursor.singleton
        )
        , leased as (
          update app.outbox_events event
          set
            lease_owner = $2,
            lease_token = $3,
            lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
            publish_attempts = event.publish_attempts + 1,
            updated_at = clock_timestamp()
          from admitted
          where event.id = admitted.id
            and admitted.publish_attempts < $6
          returning event.aggregate_id,event.aggregate_type,event.available_at,event.id,
                    event.job_name,event.lease_expires_at,event.lease_owner,event.lease_token,
                    event.payload,event.payload_checksum,event.publish_attempts,event.schema_version,event.workspace_id
        )
        select
          coalesce(
            jsonb_agg(to_jsonb(leased) order by leased.available_at, leased.id),
            '[]'::jsonb
          ) as events,
          (select count(*)::integer from exhausted) as exhausted_count,
          (select count(*)::integer from cursor_updated) as cursor_update_count,
          (select count(*)::integer from released_exhausted_admissions) as released_admission_count
        from leased
      `,
      [
        parsed.limit,
        parsed.leaseOwner,
        parsed.leaseToken,
        parsed.leaseDurationMillis,
        parsed.enabledJobNames,
        parsed.maxAttempts,
      ],
    );
    const row = claimQueryResultSchema.parse(result.rows[0]);
    const claim = Object.freeze({
      events: Object.freeze(row.events.map(toLeasedEvent)),
      exhaustedCount: row.exhausted_count,
    });
    transactionState = 'committing';
    releaseError = true;
    await client.query('commit');
    transactionState = 'closed';
    releaseError = undefined;
    return claim;
  } catch (error: unknown) {
    if (transactionState === 'open') {
      try {
        await client.query('rollback');
        transactionState = 'closed';
      } catch {
        releaseError = true;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
