import {
  bigint,
  boolean,
  char,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { workspaces } from './foundation.js';

export const workspaceControlLedgerProjection = appSchema.table(
  'workspace_control_ledger_projection',
  {
    workspaceId: uuid('workspace_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    commandId: uuid('command_id').notNull(),
    commandType: varchar('command_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    previousHash: char('previous_hash', { length: 64 }).notNull(),
    recordHash: char('record_hash', { length: 64 }).notNull(),
    actorRef: varchar('actor_ref', { length: 128 }).notNull(),
    legalAuthority: varchar('legal_authority', { length: 256 }),
    reason: varchar('reason', { length: 512 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    projectedAt: timestamp('projected_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.sequence] }),
    uniqueIndex('workspace_control_ledger_projection_command_unique').on(
      table.workspaceId,
      table.commandId,
    ),
    uniqueIndex('workspace_control_ledger_projection_subject_record_unique').on(
      table.workspaceId,
      table.sequence,
      table.subjectId,
      table.commandType,
      table.recordHash,
    ),
    uniqueIndex('workspace_control_ledger_projection_command_record_unique').on(
      table.workspaceId,
      table.commandId,
      table.subjectId,
      table.commandType,
      table.sequence,
    ),
    uniqueIndex('workspace_control_ledger_projection_audit_record_unique').on(
      table.workspaceId,
      table.commandId,
      table.subjectId,
      table.commandType,
      table.sequence,
      table.recordHash,
      table.actorRef,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'workspace_control_ledger_projection_workspace_fk',
    }),
  ],
);
export const workspaceLegalHolds = appSchema.table(
  'workspace_legal_holds',
  {
    workspaceId: uuid('workspace_id').notNull(),
    holdId: uuid('hold_id').notNull(),
    placedSequence: bigint('placed_sequence', { mode: 'number' }).notNull(),
    placedRecordHash: char('placed_record_hash', { length: 64 }).notNull(),
    legalAuthority: varchar('legal_authority', { length: 256 }).notNull(),
    placementReason: varchar('placement_reason', { length: 512 }).notNull(),
    placedBy: varchar('placed_by', { length: 128 }).notNull(),
    placedAt: timestamp('placed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    releasedSequence: bigint('released_sequence', { mode: 'number' }),
    releasedRecordHash: char('released_record_hash', { length: 64 }),
    releaseAuthority: varchar('release_authority', { length: 256 }),
    releaseReason: varchar('release_reason', { length: 512 }),
    releasedBy: varchar('released_by', { length: 128 }),
    releasedAt: timestamp('released_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.holdId] }),
    index('workspace_legal_holds_active_idx')
      .on(table.workspaceId, table.holdId)
      .where(sql`${table.releasedSequence} is null`),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'workspace_legal_holds_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.placedSequence],
      foreignColumns: [
        workspaceControlLedgerProjection.workspaceId,
        workspaceControlLedgerProjection.sequence,
      ],
      name: 'workspace_legal_holds_placement_record_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.releasedSequence],
      foreignColumns: [
        workspaceControlLedgerProjection.workspaceId,
        workspaceControlLedgerProjection.sequence,
      ],
      name: 'workspace_legal_holds_release_record_fk',
    }),
  ],
);
export const retentionControlAuditFacts = appSchema.table(
  'retention_control_audit_facts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    commandId: uuid('command_id').notNull(),
    factType: varchar('fact_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    controlSequence: bigint('control_sequence', { mode: 'number' }).notNull(),
    controlRecordHash: char('control_record_hash', { length: 64 }).notNull(),
    actorRef: varchar('actor_ref', { length: 128 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    recordedAt: timestamp('recorded_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('retention_control_audit_facts_command_unique').on(
      table.workspaceId,
      table.commandId,
    ),
    index('retention_control_audit_facts_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    foreignKey({
      columns: [
        table.workspaceId,
        table.commandId,
        table.subjectId,
        table.factType,
        table.controlSequence,
        table.controlRecordHash,
        table.actorRef,
        table.occurredAt,
      ],
      foreignColumns: [
        workspaceControlLedgerProjection.workspaceId,
        workspaceControlLedgerProjection.commandId,
        workspaceControlLedgerProjection.subjectId,
        workspaceControlLedgerProjection.commandType,
        workspaceControlLedgerProjection.sequence,
        workspaceControlLedgerProjection.recordHash,
        workspaceControlLedgerProjection.actorRef,
        workspaceControlLedgerProjection.occurredAt,
      ],
      name: 'retention_control_audit_facts_record_fk',
    }),
  ],
);
export const retentionBatches = appSchema.table(
  'retention_batches',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    retentionKind: varchar('retention_kind', { length: 32 }).notNull(),
    cutoffAt: timestamp('cutoff_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    retentionStage: varchar('retention_stage', { length: 32 })
      .default('records')
      .notNull(),
    dryRun: boolean('dry_run').default(true).notNull(),
    dryRunCursor: jsonb('dry_run_cursor'),
    dryRunUpper: jsonb('dry_run_upper'),
    requestedBy: varchar('requested_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 512 }).notNull(),
    status: varchar('status', { length: 16 }).default('ready').notNull(),
    pauseReason: varchar('pause_reason', { length: 32 }),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }),
    cursorExpiresAt: timestamp('cursor_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cursorId: uuid('cursor_id'),
    examinedCount: bigint('examined_count', { mode: 'number' })
      .default(0)
      .notNull(),
    eligibleCount: bigint('eligible_count', { mode: 'number' })
      .default(0)
      .notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseFence: bigint('lease_fence', { mode: 'number' }).default(0).notNull(),
    leaseAcquiredAt: timestamp('lease_acquired_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    uniqueIndex('retention_batches_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('retention_batches_claim_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.status} in ('ready', 'running', 'paused')`),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'retention_batches_workspace_fk',
    }),
  ],
);
export const retentionScheduleState = appSchema.table(
  'retention_schedule_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    retentionKind: varchar('retention_kind', { length: 32 }).notNull(),
    nextScanAt: timestamp('next_scan_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    lastScannedAt: timestamp('last_scanned_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastCutoffAt: timestamp('last_cutoff_at', {
      withTimezone: true,
      mode: 'date',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.retentionKind] }),
    index('retention_schedule_state_due_idx').on(
      table.nextScanAt,
      table.workspaceId,
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: 'retention_schedule_state_workspace_fk',
    }).onDelete('cascade'),
  ],
);
