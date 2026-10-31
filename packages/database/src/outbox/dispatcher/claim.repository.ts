import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  outboxEvents,
  outboxFairDispatchCursor,
} from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';
import type {
  ClaimOutboxBatchInput,
  ClaimOutboxBatchResult,
} from './contract.js';
import type { LeasedOutboxEvent } from './contract.js';

export async function claimOutboxBatch(
  pool: Pool,
  input: ClaimOutboxBatchInput,
): Promise<ClaimOutboxBatchResult> {
  if (input.enabledJobNames.length === 0) {
    return Object.freeze({ events: Object.freeze([]) });
  }
  const client = await pool.connect();
  let transactionState: 'not_started' | 'open' | 'committing' | 'closed' =
    'not_started';
  let releaseError: true | undefined;
  try {
    await client.query('begin');
    transactionState = 'open';
    await drizzle(client)
      .execute(
        sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
      )
      .catch(rethrowQueryFailure);
    await drizzle(client)
      .execute(sql`select app.recover_due_workflow_run_active_admissions(100)`)
      .catch(rethrowQueryFailure);
    const claim = await leaseFairOutboxBatch(client, input);
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

const event = alias(outboxEvents, 'event');
const dispatchCursor = alias(outboxFairDispatchCursor, 'cursor');
const cursor_state = alias(outboxFairDispatchCursor, 'cursor_state');
const eligible = alias(outboxEvents, 'eligible');
const workspace_round = alias(outboxEvents, 'workspace_round');
const candidates = alias(outboxEvents, 'candidates');
const admitted = alias(outboxEvents, 'admitted');
const leased = alias(outboxEvents, 'leased');
const leasedProjection = sql.join(
  [
    sql`${leased.aggregateId} as ${sql.identifier('aggregateId')}`,
    sql`${leased.aggregateType} as ${sql.identifier('aggregateType')}`,
    sql`${leased.availableAt} as ${sql.identifier('availableAt')}`,
    sql`${leased.id} as ${sql.identifier('id')}`,
    sql`${leased.jobName} as ${sql.identifier('jobName')}`,
    sql`${leased.leaseExpiresAt} as ${sql.identifier('leaseExpiresAt')}`,
    sql`${leased.leaseOwner} as ${sql.identifier('leaseOwner')}`,
    sql`${leased.leaseToken} as ${sql.identifier('leaseToken')}`,
    sql`${leased.payload} as ${sql.identifier('payload')}`,
    sql`${leased.payloadChecksum} as ${sql.identifier('payloadChecksum')}`,
    sql`${leased.publishAttempts} as ${sql.identifier('publishAttempts')}`,
    sql`${leased.workspaceId} as ${sql.identifier('workspaceId')}`,
  ],
  sql`, `,
);
type RawLeasedEvent = Omit<
  LeasedOutboxEvent,
  'availableAt' | 'leaseExpiresAt'
> &
  Readonly<{ availableAt: string; leaseExpiresAt: string }>;
type ClaimRow = (RawLeasedEvent | Readonly<{ id: null }>) &
  Readonly<{ cursorUpdateCount: number }>;

async function leaseFairOutboxBatch(
  client: PoolClient,
  parsed: ClaimOutboxBatchInput,
): Promise<ClaimOutboxBatchResult> {
  const result = await drizzle(client)
    .execute<ClaimRow>(
      sql`
        with cursor_state as materialized (
          select ${sql.identifier(outboxFairDispatchCursor.lastWorkspaceId.name)}
          from ${outboxFairDispatchCursor}
          where ${sql.identifier(outboxFairDispatchCursor.singleton.name)}
          for update
        ), workspace_round as materialized (
          select ${eligible.workspaceId},
                 row_number() over (order by
                   case when ${cursor_state.lastWorkspaceId} is null then 0
                        when ${eligible.workspaceId} > ${cursor_state.lastWorkspaceId} then 0
                        else 1 end,
                   ${eligible.workspaceId}) as round_ordinal
          from (
            select distinct ${sql.identifier(outboxEvents.workspaceId.name)}
            from ${outboxEvents}
            where ${sql.identifier(outboxEvents.publishedAt.name)} is null
              and ${sql.identifier(outboxEvents.failedAt.name)} is null
              and ${sql.identifier(outboxEvents.jobName.name)} = any(${sql.param(parsed.enabledJobNames)}::varchar[])
              and ${sql.identifier(outboxEvents.availableAt.name)} <= clock_timestamp()
              and (${sql.identifier(outboxEvents.leaseExpiresAt.name)} is null or ${sql.identifier(outboxEvents.leaseExpiresAt.name)} <= clock_timestamp())
          ) eligible
          cross join cursor_state
          order by
            case when ${cursor_state.lastWorkspaceId} is null then 0
                 when ${eligible.workspaceId} > ${cursor_state.lastWorkspaceId} then 0
                 else 1 end,
            ${eligible.workspaceId}
          limit ${parsed.limit}
        ), candidates as materialized (
          select picked.${sql.identifier(outboxEvents.id.name)},picked.${sql.identifier(outboxEvents.publishAttempts.name)},picked.${sql.identifier(outboxEvents.jobName.name)},
                 picked.${sql.identifier(outboxEvents.aggregateType.name)},picked.${sql.identifier(outboxEvents.aggregateId.name)},
                 ${workspace_round.workspaceId},workspace_round.round_ordinal
          from workspace_round
          cross join lateral (
            select ${sql.identifier(outboxEvents.id.name)},${sql.identifier(outboxEvents.publishAttempts.name)},${sql.identifier(outboxEvents.jobName.name)},${sql.identifier(outboxEvents.aggregateType.name)},${sql.identifier(outboxEvents.aggregateId.name)}
            from ${outboxEvents} event
            where ${event.workspaceId}=${workspace_round.workspaceId}
              and ${sql.identifier(outboxEvents.publishedAt.name)} is null
              and ${sql.identifier(outboxEvents.failedAt.name)} is null
              and ${sql.identifier(outboxEvents.jobName.name)} = any(${sql.param(parsed.enabledJobNames)}::varchar[])
              and ${sql.identifier(outboxEvents.availableAt.name)} <= clock_timestamp()
              and (${sql.identifier(outboxEvents.leaseExpiresAt.name)} is null or ${sql.identifier(outboxEvents.leaseExpiresAt.name)} <= clock_timestamp())
              and (
                ${sql.identifier(outboxEvents.jobName.name)} <> 'advance-workflow-run'
                or app.workflow_run_active_admission_eligible(
                     ${event.workspaceId},${event.id},${event.aggregateId}
                   )
              )
            order by ${sql.identifier(outboxEvents.availableAt.name)},${sql.identifier(outboxEvents.id.name)}
            for update skip locked
            limit 1
          ) picked
        ), admitted as materialized (
          select candidates.*
          from candidates
          where ${candidates.jobName} <> 'advance-workflow-run'
             or app.reserve_workflow_run_active_admission(
                  ${candidates.workspaceId},${candidates.id},${candidates.aggregateId}
                )
        ), cursor_updated as (
          update ${outboxFairDispatchCursor} cursor
          set ${sql.identifier(outboxFairDispatchCursor.lastWorkspaceId.name)}=(
                select ${sql.identifier(outboxEvents.workspaceId.name)} from workspace_round
                order by round_ordinal desc limit 1
              ),
              ${sql.identifier(outboxEvents.updatedAt.name)}=clock_timestamp()
          where ${dispatchCursor.singleton} and exists(select 1 from workspace_round)
          returning ${dispatchCursor.singleton}
        )
        , leased as (
          update ${outboxEvents} event
          set
            ${sql.identifier(outboxEvents.leaseOwner.name)} = ${parsed.leaseOwner},
            ${sql.identifier(outboxEvents.leaseToken.name)} = ${parsed.leaseToken},
            ${sql.identifier(outboxEvents.leaseExpiresAt.name)} = clock_timestamp() + (${parsed.leaseDurationMillis}::integer * interval '1 millisecond'),
            ${sql.identifier(outboxEvents.publishAttempts.name)} = ${event.publishAttempts} + 1,
            ${sql.identifier(outboxEvents.updatedAt.name)} = clock_timestamp()
          from admitted
          where ${event.id} = ${admitted.id}
          returning ${event.aggregateId},${event.aggregateType},${event.availableAt},${event.id},
                    ${event.jobName},${event.leaseExpiresAt},${event.leaseOwner},${event.leaseToken},
                    ${event.payload},${event.payloadChecksum},${event.publishAttempts},${event.workspaceId}
        )
        select ${leasedProjection},
          (select count(*)::integer from cursor_updated) as "cursorUpdateCount"
        from (select 1) summary
        left join leased on true
        order by ${leased.availableAt}, ${leased.id}
`,
    )
    .catch(rethrowQueryFailure);
  if (result.rows[0] === undefined)
    throw new Error('Outbox claim returned no summary');
  const events: LeasedOutboxEvent[] = [];
  for (const row of result.rows) {
    if (row.id === null) continue;
    const { cursorUpdateCount, ...event } = row;
    // Raw queue SQL bypasses Drizzle's timestamp decoder.
    events.push(
      Object.freeze({
        ...event,
        availableAt: new Date(event.availableAt),
        leaseExpiresAt: new Date(event.leaseExpiresAt),
      }),
    );
  }
  return Object.freeze({ events: Object.freeze(events) });
}
