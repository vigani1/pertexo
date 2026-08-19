import { Pool } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from './readiness.js';

const claimInputSchema = z.object({
  leaseDurationMillis: z.number().int().min(1_000).max(300_000),
  leaseOwner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  leaseToken: z.uuid(),
  limit: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(1_000),
});

const leasedEventSchema = z.object({
  id: z.uuid(),
  leaseToken: z.uuid(),
});

const releaseInputSchema = leasedEventSchema.extend({
  errorCode: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
  maxAttempts: z.number().int().min(1).max(1_000),
  retryAt: z.date(),
});

export type ClaimOutboxBatchInput = Readonly<z.input<typeof claimInputSchema>>;
export type LeasedOutboxEvent = Readonly<{
  aggregateId: string;
  aggregateType: string;
  availableAt: Date;
  id: string;
  jobName: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  payload: unknown;
  payloadChecksum: string;
  publishAttempts: number;
  schemaVersion: number;
  workspaceId: string;
}>;

export type ReleaseOutboxResult = 'retry_scheduled' | 'failed' | 'not_leased';

export type OutboxBacklogSnapshot = Readonly<{
  backlog: number;
  /** Age of the oldest due, claimable row. Omitted when the backlog is empty. */
  oldestAgeSeconds?: number;
}>;

export type ClaimOutboxBatchResult = Readonly<{
  events: readonly LeasedOutboxEvent[];
  /** Rows atomically terminalized because their publish-attempt ceiling was reached. */
  exhaustedCount: number;
}>;

export interface OutboxDispatcherDatabase {
  claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimOutboxBatchResult>;
  markPublished(eventId: string, leaseToken: string): Promise<boolean>;
  releaseOrFail(
    input: z.input<typeof releaseInputSchema>,
  ): Promise<ReleaseOutboxResult>;
  observeBacklog(): Promise<OutboxBacklogSnapshot>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

interface ClaimedRow {
  aggregate_id: string;
  aggregate_type: string;
  available_at: string;
  id: string;
  job_name: string;
  lease_expires_at: string;
  lease_owner: string;
  lease_token: string;
  payload: unknown;
  payload_checksum: string;
  publish_attempts: number;
  schema_version: number;
  workspace_id: string;
}

interface ClaimQueryResult {
  events: ClaimedRow[];
  exhausted_count: number;
}

function toLeasedEvent(row: ClaimedRow): LeasedOutboxEvent {
  return Object.freeze({
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    availableAt: new Date(row.available_at),
    id: row.id,
    jobName: row.job_name,
    leaseExpiresAt: new Date(row.lease_expires_at),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    payload: row.payload,
    payloadChecksum: row.payload_checksum,
    publishAttempts: row.publish_attempts,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
  });
}

async function checkDispatcherReadiness(
  pool: Pool,
  ownerRole: string,
): Promise<void> {
  const result = await pool.query<{
    can_delete: boolean;
    can_insert: boolean;
    can_select: boolean;
    can_update: boolean;
    can_update_immutable: boolean;
    can_update_table: boolean;
    migration_head: string | null;
    owner_member: boolean;
    policy_count: number;
    postgres_major: number;
    relforcerowsecurity: boolean;
    relrowsecurity: boolean;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    `
      select
        current_setting('server_version_num')::integer / 10000 as postgres_major,
        role.rolsuper,
        role.rolbypassrls,
        pg_has_role(current_user, $1::name, 'MEMBER') as owner_member,
        table_class.relrowsecurity,
        table_class.relforcerowsecurity,
        has_table_privilege(current_user, table_class.oid, 'SELECT') as can_select,
        has_any_column_privilege(current_user, table_class.oid, 'UPDATE') as can_update,
        has_table_privilege(current_user, table_class.oid, 'UPDATE') as can_update_table,
        exists (
          select 1
          from pg_attribute attribute
          where attribute.attrelid = table_class.oid
            and attribute.attname = any(array[
              'id',
              'workspace_id',
              'job_name',
              'schema_version',
              'aggregate_type',
              'aggregate_id',
              'payload',
              'payload_checksum',
              'created_at'
            ])
            and has_column_privilege(
              current_user,
              table_class.oid,
              attribute.attnum,
              'UPDATE'
            )
        ) as can_update_immutable,
        has_table_privilege(current_user, table_class.oid, 'INSERT') as can_insert,
        has_table_privilege(current_user, table_class.oid, 'DELETE') as can_delete,
        (
          select count(*)::integer
          from pg_policy policy
          where policy.polrelid = table_class.oid
            and policy.polname in (
              'outbox_events_dispatcher_select',
              'outbox_events_dispatcher_update'
            )
            and role.oid = any(policy.polroles)
        ) as policy_count,
        (
          select name
          from pertexo_internal.schema_migrations
          order by name desc
          limit 1
        ) as migration_head
      from pg_roles role
      join pg_class table_class on table_class.oid = 'app.outbox_events'::regclass
      where role.rolname = current_user
    `,
    [ownerRole],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.postgres_major < MINIMUM_POSTGRES_MAJOR ||
    row.migration_head !== EXPECTED_MIGRATION_HEAD ||
    !row.relrowsecurity ||
    !row.relforcerowsecurity ||
    !row.can_select ||
    !row.can_update ||
    row.can_update_immutable ||
    row.can_update_table ||
    row.can_insert ||
    row.can_delete ||
    row.policy_count !== 2 ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.owner_member
  ) {
    throw new Error('Outbox dispatcher database boundary is incompatible');
  }
}

export function createOutboxDispatcherDatabase(
  config: DatabaseConfig,
): OutboxDispatcherDatabase {
  const { ownerRole, ...poolConfig } = config;
  const pool = new Pool(poolConfig);

  return Object.freeze({
    claimBatch: async (
      input: ClaimOutboxBatchInput,
    ): Promise<ClaimOutboxBatchResult> => {
      const parsed = claimInputSchema.parse(input);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await client.query<ClaimQueryResult>(
          `
            with candidates as materialized (
              select id, publish_attempts
              from app.outbox_events
              where published_at is null
                and failed_at is null
                and available_at <= clock_timestamp()
                and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
              order by available_at, id
              for update skip locked
              limit $1
            ), exhausted as (
              update app.outbox_events event
              set
                failed_at = clock_timestamp(),
                last_error_code = 'publish.attempts_exhausted',
                lease_owner = null,
                lease_token = null,
                lease_expires_at = null,
                updated_at = clock_timestamp()
              from candidates
              where event.id = candidates.id
                and candidates.publish_attempts >= $5
              returning event.id
            )
            , leased as (
              update app.outbox_events event
              set
                lease_owner = $2,
                lease_token = $3,
                lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
                publish_attempts = event.publish_attempts + 1,
                updated_at = clock_timestamp()
              from candidates
              where event.id = candidates.id
                and candidates.publish_attempts < $5
              returning event.*
            )
            select
              coalesce(
                jsonb_agg(to_jsonb(leased) order by leased.available_at, leased.id),
                '[]'::jsonb
              ) as events,
              (select count(*)::integer from exhausted) as exhausted_count
            from leased
          `,
          [
            parsed.limit,
            parsed.leaseOwner,
            parsed.leaseToken,
            parsed.leaseDurationMillis,
            parsed.maxAttempts,
          ],
        );
        await client.query('commit');
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error('Outbox claim returned no summary row');
        }
        return Object.freeze({
          events: Object.freeze(row.events.map(toLeasedEvent)),
          exhaustedCount: row.exhausted_count,
        });
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    markPublished: async (
      eventId: string,
      leaseToken: string,
    ): Promise<boolean> => {
      const parsed = leasedEventSchema.parse({ id: eventId, leaseToken });
      const result = await pool.query(
        `
          update app.outbox_events
          set
            published_at = clock_timestamp(),
            lease_owner = null,
            lease_token = null,
            lease_expires_at = null,
            last_error_code = null,
            updated_at = clock_timestamp()
          where id = $1
            and lease_token = $2
            and published_at is null
            and failed_at is null
        `,
        [parsed.id, parsed.leaseToken],
      );
      return result.rowCount === 1;
    },
    releaseOrFail: async (
      input: z.input<typeof releaseInputSchema>,
    ): Promise<ReleaseOutboxResult> => {
      const parsed = releaseInputSchema.parse(input);
      const result = await pool.query<{ failed: boolean }>(
        `
          update app.outbox_events
          set
            available_at = case
              when publish_attempts >= $4 then available_at
              else $3
            end,
            failed_at = case
              when publish_attempts >= $4 then clock_timestamp()
              else null
            end,
            last_error_code = $5,
            lease_owner = null,
            lease_token = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
          where id = $1
            and lease_token = $2
            and published_at is null
            and failed_at is null
          returning failed_at is not null as failed
        `,
        [
          parsed.id,
          parsed.leaseToken,
          parsed.retryAt,
          parsed.maxAttempts,
          parsed.errorCode,
        ],
      );
      const row = result.rows[0];
      return row === undefined
        ? 'not_leased'
        : row.failed
          ? 'failed'
          : 'retry_scheduled';
    },
    observeBacklog: async (): Promise<OutboxBacklogSnapshot> => {
      const result = await pool.query<{
        backlog: number;
        oldest_age_seconds: number | null;
      }>(`
        select
          count(*)::integer as backlog,
          extract(
            epoch from (clock_timestamp() - min(available_at))
          )::double precision as oldest_age_seconds
        from app.outbox_events
        where published_at is null
          and failed_at is null
          and available_at <= clock_timestamp()
          and (
            lease_expires_at is null
            or lease_expires_at <= clock_timestamp()
          )
      `);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Outbox backlog observation returned no row');
      }
      return Object.freeze({
        backlog: row.backlog,
        ...(row.oldest_age_seconds === null
          ? {}
          : { oldestAgeSeconds: Math.max(0, row.oldest_age_seconds) }),
      });
    },
    checkReadiness: async (): Promise<void> =>
      checkDispatcherReadiness(pool, ownerRole),
    close: async (): Promise<void> => pool.end(),
  });
}
