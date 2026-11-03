import type { PreviewAttemptLease, PreviewStatus } from '../stored-shapes.js';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import {
  bigint,
  check,
  foreignKey,
  index,
  json,
  jsonb,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { previewRuns } from './runs.js';

export const previewAttempts = appSchema.table(
  'preview_attempts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    previewRunId: uuid('preview_run_id').notNull(),
    status: varchar('status', { length: 32 })
      .$type<PreviewStatus>()
      .default('queued')
      .notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 })
      .$type<PreviewAttemptLease['sideEffectClass']>()
      .notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', {
      length: 256,
    }),
    providerDispatchBinding: varchar('provider_dispatch_binding', {
      length: 128,
    }),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    fenceToken: bigint('fence_token', { mode: 'number' }).default(0).notNull(),
    dispatchMarkedAt: timestamp('dispatch_marked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    outputRef: json('output_ref'),
    codeDiagnostics: jsonb('code_diagnostics').$type<CodeDiagnostics>(),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    errorSummary: varchar('error_summary', { length: 2048 }),
    reconciliationRef: jsonb('reconciliation_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'preview_attempts_code_diagnostics_bound',
      sql`${table.codeDiagnostics} IS NULL OR (jsonb_typeof(${table.codeDiagnostics})='object' AND octet_length(${table.codeDiagnostics}::text)<=1048576)`,
    ),
    check(
      'preview_attempts_error_code_format',
      sql`((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check('preview_attempts_fence_nonnegative', sql`(fence_token >= 0)`),
    check(
      'preview_attempts_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))`,
    ),
    check(
      'preview_attempts_lease_owner_format',
      sql`((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))`,
    ),
    check(
      'preview_attempts_output_bounded',
      sql`((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))`,
    ),
    check(
      'preview_attempts_output_truth',
      sql`((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))`,
    ),
    check(
      'preview_attempts_provider_dispatch_binding_format',
      sql`((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'::text))`,
    ),
    check(
      'preview_attempts_provider_key_bounded',
      sql`((provider_idempotency_key IS NULL) OR ((length((provider_idempotency_key)::text) >= 1) AND (length((provider_idempotency_key)::text) <= 256)))`,
    ),
    check(
      'preview_attempts_reconciliation_bounded',
      sql`((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))`,
    ),
    check(
      'preview_attempts_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'preview_attempts_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'preview_attempts_terminal_shape',
      sql`((((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text])) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (completed_at IS NOT NULL)))`,
    ),
    check(
      'preview_attempts_time_order',
      sql`(((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)) AND ((dispatch_marked_at IS NULL) OR (started_at IS NOT NULL)))`,
    ),
    unique('preview_attempts_one_per_run').on(table.previewRunId),
    unique('preview_attempts_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'preview_attempts_run_fk',
      columns: [table.workspaceId, table.previewRunId],
      foreignColumns: [previewRuns.workspaceId, previewRuns.id],
    }).onDelete('restrict'),
    index('preview_attempts_claim_idx')
      .on(table.status, table.leaseExpiresAt, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]))`,
      ),
  ],
);
