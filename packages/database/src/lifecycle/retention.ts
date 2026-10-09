import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';
import { inRetentionTransaction } from './retention-transaction.js';
import {
  reapTransientData,
  type TransientDataReapResult,
} from './transient-data-retention.js';

export type { TransientDataReapResult } from './transient-data-retention.js';

/**
 * What retention removes and when. Each rule clears or deletes at most one page
 * of rows per call, and one worker at a time runs a given rule. Later rules
 * depend on earlier ones: a run summary is deleted only once its details are
 * gone and no trigger record or replay still refers to it.
 */
export const RETENTION_RULES = Object.freeze([
  {
    // A run's input is kept until the expiry recorded with it.
    name: 'run_inputs',
    statement: `
      with page as (
        select id from app.workflow_runs
        where input_ref is not null and input_ref_expires_at <= clock_timestamp()
        order by input_ref_expires_at, id limit $1 for update skip locked
      )
      update app.workflow_runs run
      set input_ref = null, input_ref_expires_at = null, updated_at = clock_timestamp()
      from page where run.id = page.id`,
  },
  {
    // Execution details go 30 days after a run completes. Deleting a node run
    // deletes its attempts.
    name: 'node_runs',
    statement: `
      with page as (
        select node.workspace_id, node.id
        from app.node_runs node
        join app.workflow_runs run
          on run.workspace_id = node.workspace_id and run.id = node.workflow_run_id
        where run.completed_at <= clock_timestamp() - interval '30 days'
        order by node.id limit $1
      )
      delete from app.node_runs node using page
      where node.workspace_id = page.workspace_id and node.id = page.id`,
  },
  {
    name: 'run_events',
    statement: `
      with page as (
        select event.workflow_run_id, event.sequence
        from app.run_events event
        join app.workflow_runs run
          on run.workspace_id = event.workspace_id and run.id = event.workflow_run_id
        where run.completed_at <= clock_timestamp() - interval '30 days'
        order by event.workflow_run_id, event.sequence limit $1
      )
      delete from app.run_events event using page
      where event.workflow_run_id = page.workflow_run_id
        and event.sequence = page.sequence`,
  },
  {
    name: 'run_checkpoints',
    statement: `
      with page as (
        select checkpoint.workflow_run_id
        from app.run_checkpoints checkpoint
        join app.workflow_runs run
          on run.workspace_id = checkpoint.workspace_id
         and run.id = checkpoint.workflow_run_id
        where run.completed_at <= clock_timestamp() - interval '30 days'
        order by checkpoint.workflow_run_id limit $1
      )
      delete from app.run_checkpoints checkpoint using page
      where checkpoint.workflow_run_id = page.workflow_run_id`,
  },
  {
    // The run summary stays; its output, error and cancel reason go with the
    // details.
    name: 'run_details',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where run.details_purged_at is null
          and run.completed_at <= clock_timestamp() - interval '30 days'
          and not exists (select 1 from app.node_runs node
            where node.workspace_id = run.workspace_id and node.workflow_run_id = run.id)
          and not exists (select 1 from app.run_events event
            where event.workspace_id = run.workspace_id and event.workflow_run_id = run.id)
          and not exists (select 1 from app.run_checkpoints checkpoint
            where checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id)
        order by run.completed_at, run.id limit $1 for update skip locked
      )
      update app.workflow_runs run
      set output_ref = null, error_summary = null, cancel_reason = null,
          details_purged_at = clock_timestamp(), updated_at = clock_timestamp()
      from page where run.id = page.id`,
  },
  {
    // Webhook replay records keep their own expiry.
    name: 'webhook_replay_records',
    statement: `
      with page as (
        select endpoint_id, dedupe_kind, dedupe_key_hash
        from app.webhook_trigger_replay_records
        where expires_at <= clock_timestamp()
        order by expires_at, endpoint_id limit $1
      )
      delete from app.webhook_trigger_replay_records replay using page
      where replay.endpoint_id = page.endpoint_id
        and replay.dedupe_kind = page.dedupe_kind
        and replay.dedupe_key_hash = page.dedupe_key_hash`,
  },
  {
    name: 'webhook_deliveries',
    statement: `
      with page as (
        select delivery.id from app.webhook_trigger_deliveries delivery
        where delivery.expires_at <= clock_timestamp()
          and not exists (select 1 from app.webhook_trigger_replay_records replay
            where replay.workspace_id = delivery.workspace_id
              and replay.delivery_id = delivery.id)
        order by delivery.expires_at, delivery.id limit $1
      )
      delete from app.webhook_trigger_deliveries delivery using page
      where delivery.id = page.id`,
  },
  {
    name: 'schedule_occurrences',
    statement: `
      with page as (
        select id from app.trigger_schedule_occurrences
        where scheduled_at <= clock_timestamp() - interval '90 days'
        order by scheduled_at, id limit $1
      )
      delete from app.trigger_schedule_occurrences occurrence using page
      where occurrence.id = page.id`,
  },
  {
    // A run summary goes 90 days after completion, once nothing refers to it.
    name: 'run_summaries',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where run.completed_at <= clock_timestamp() - interval '90 days'
          and run.details_purged_at is not null
          and not exists (select 1 from app.workflow_runs child
            where child.workspace_id = run.workspace_id
              and child.replay_source_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_deliveries delivery
            where delivery.workspace_id = run.workspace_id
              and delivery.workflow_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_replay_records replay
            where replay.workspace_id = run.workspace_id
              and replay.workflow_run_id = run.id)
          and not exists (select 1 from app.trigger_schedule_occurrences occurrence
            where occurrence.workspace_id = run.workspace_id
              and occurrence.workflow_run_id = run.id)
        order by run.completed_at, run.id limit $1 for update skip locked
      )
      delete from app.workflow_runs run using page where run.id = page.id`,
  },
  {
    // Audit records are kept for a year.
    name: 'audit_events',
    statement: `
      with page as (
        select id from app.audit_events
        where occurred_at <= clock_timestamp() - interval '365 days'
        order by occurred_at, id limit $1
      )
      delete from app.audit_events audit using page where audit.id = page.id`,
  },
  {
    name: 'transport_security_audit_facts',
    statement: `
      with page as (
        select id from app.transport_security_audit_facts
        where occurred_at <= clock_timestamp() - interval '365 days'
        order by occurred_at, id limit $1
      )
      delete from app.transport_security_audit_facts fact using page
      where fact.id = page.id`,
  },
] as const);

/** Advisory lock class for the rules; the rule's index is the second key. */
const RETENTION_LOCK_CLASS = 1_934_781_128;

export type RetentionRuleName = (typeof RETENTION_RULES)[number]['name'];

export type RetentionPassResult = Readonly<{
  /** Rows each rule removed or cleared. */
  removed: Readonly<Record<RetentionRuleName, number>>;
  /** Some rule filled its page, so more rows are due now. */
  more: boolean;
}>;

export interface RetentionDatabase {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Runs every rule once, one page each. */
  enforce(signal?: AbortSignal): Promise<RetentionPassResult>;
  reapTransientData(signal?: AbortSignal): Promise<TransientDataReapResult>;
}

const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    pageSize: z.number().int().min(1).max(1_000).default(100),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .strict();

export type RetentionDatabaseOptions = z.input<typeof optionsSchema>;

export function createRetentionDatabase(
  config: DatabaseConfig,
  inputOptions: RetentionDatabaseOptions = {},
  runtime?: DatabaseRuntime,
): RetentionDatabase {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
    enforce: async (signal?: AbortSignal) => {
      const removed: Partial<Record<RetentionRuleName, number>> = {};
      // One transaction per rule keeps each page's locks short. A rule
      // another worker is running is skipped this pass.
      for (const [index, rule] of RETENTION_RULES.entries())
        removed[rule.name] = await inRetentionTransaction(
          pool,
          options,
          signal,
          async (client) => {
            const lock = await client.query<{ locked: boolean }>(
              'select pg_try_advisory_xact_lock($1, $2) locked',
              [RETENTION_LOCK_CLASS, index],
            );
            if (lock.rows[0]?.locked !== true) return 0;
            return (
              (await client.query(rule.statement, [options.pageSize]))
                .rowCount ?? 0
            );
          },
        );
      return Object.freeze({
        removed: Object.freeze(removed as RetentionPassResult['removed']),
        more: Object.values(removed).some((count) => count >= options.pageSize),
      });
    },
    reapTransientData: (signal?: AbortSignal) =>
      reapTransientData(pool, options, signal),
  });
}
