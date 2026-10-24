import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import type { z } from 'zod';
import {
  leasedEventSchema,
  releaseInputSchema,
  observeBacklogInputSchema,
} from './input.js';
import type {
  OutboxDispatcherDatabase,
  OutboxBacklogSnapshot,
  ObserveOutboxBacklogInput,
  ReleaseOutboxResult,
} from './contract.js';

import type { DatabaseConfig } from '../../config.js';

import {
  claimOutboxBatch,
  type ClaimOutboxBatchInput,
  type ClaimOutboxBatchResult,
} from './claim.repository.js';
import { checkDatabaseReadiness } from '../../platform/readiness.js';

export function createOutboxDispatcherDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): OutboxDispatcherDatabase {
  const { ownerRole, ...poolConfig } = config;
  const lease = acquireDatabasePool({ ...config, ...poolConfig }, runtime, {
    role: 'dispatcher',
  });
  const { pool } = lease;

  return Object.freeze({
    claimBatch: (input: ClaimOutboxBatchInput) => claimOutboxBatch(pool, input),
    markPublished: async (
      eventId: string,
      leaseToken: string,
    ): Promise<boolean> => {
      const parsed = leasedEventSchema.parse({ id: eventId, leaseToken });
      const result = await pool.query(
        `
          with published as (
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
          returning workspace_id,id
          ) select id,
              app.arm_dispatcher_workflow_run_active_admission(workspace_id,id)
                as armed_admission
            from published
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
          with updated as (
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
          returning failed_at is not null as failed,workspace_id,id
          ) select failed,
              case when failed then
                app.release_dispatcher_workflow_run_active_admission(workspace_id,id)
              else false end as released_admission
            from updated
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
      if (row === undefined) {
        return 'not_leased';
      }
      if (row.failed) {
        return 'failed';
      }
      return 'retry_scheduled';
    },
    observeBacklog: async (
      input: ObserveOutboxBacklogInput,
    ): Promise<OutboxBacklogSnapshot> => {
      const parsed = observeBacklogInputSchema.parse({
        enabledJobNames: [...input.enabledJobNames],
      });
      if (parsed.enabledJobNames.length === 0) {
        return Object.freeze({ backlog: 0 });
      }
      const result = await pool.query<{
        backlog: number;
        oldest_age_seconds: number | null;
      }>(
        `
        select
          count(*)::integer as backlog,
          extract(
            epoch from (clock_timestamp() - min(available_at))
          )::double precision as oldest_age_seconds
        from app.outbox_events
        where published_at is null
          and failed_at is null
          and job_name = any($1::varchar[])
          and available_at <= clock_timestamp()
          and (
            lease_expires_at is null
            or lease_expires_at <= clock_timestamp()
          )
      `,
        [parsed.enabledJobNames],
      );
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
    checkReadiness: async (): Promise<void> => {
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
  });
}
