import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaces } from '../tenant-access/workspaces.js';

/** Storage locations, not visibility or retention policy. JSON remains authoritative. */
export const ARTIFACT_OWNER_SOURCES = [
  {
    table: 'workflow_drafts',
    id: 'workflow_id',
    sub: null,
    values: { graph_json: 'authored' },
  },
  {
    table: 'workflow_versions',
    id: 'id',
    sub: null,
    values: { graph_json: 'authored' },
  },
  {
    table: 'workflow_test_snapshots',
    id: 'id',
    sub: null,
    values: { graph_json: 'authored' },
  },
  {
    table: 'workflow_test_suite_cases',
    id: 'suite_id',
    sub: 'ordinal',
    values: { input: 'authored-text' },
  },
  {
    table: 'workflow_input_case_payloads',
    id: 'case_id',
    sub: 'revision',
    values: { input: 'authored-text' },
  },
  {
    table: 'workflow_step_samples',
    id: 'id',
    sub: null,
    values: { output_ref: 'value-text' },
  },
  {
    table: 'preview_runs',
    id: 'id',
    sub: null,
    values: {
      input_ref: 'value',
      output_ref: 'value',
      executable_node_json: 'authored',
    },
  },
  {
    table: 'workflow_runs',
    id: 'id',
    sub: null,
    values: { input_ref: 'value', output_ref: 'value' },
  },
  {
    table: 'node_runs',
    id: 'id',
    sub: null,
    values: { input_ref: 'value', output_ref: 'value' },
  },
  {
    table: 'node_attempts',
    id: 'id',
    sub: null,
    values: { output_ref: 'value', reconciliation_ref: 'value' },
  },
  {
    table: 'run_events',
    id: 'workflow_run_id',
    sub: 'sequence',
    values: { payload: 'event' },
  },
  {
    table: 'run_checkpoints',
    id: 'workflow_run_id',
    sub: null,
    values: { scheduler_state: 'checkpoint' },
  },
  {
    table: 'pending_run_tasks',
    id: 'id',
    sub: null,
    values: { output_ref: 'value' },
  },
] as const;

export type ArtifactOwnerFamily =
  (typeof ARTIFACT_OWNER_SOURCES)[number]['table'];

export const artifactOwnerReferences = appSchema.table(
  'artifact_owner_references',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    ownerFamily: varchar('owner_family', { length: 40 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerSubId: integer('owner_sub_id').notNull(),
    ownerSlot: varchar('owner_slot', { length: 32 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'artifact_owner_references_pkey',
      columns: [
        table.workspaceId,
        table.artifactId,
        table.ownerFamily,
        table.ownerId,
        table.ownerSubId,
        table.ownerSlot,
      ],
    }),
    index('artifact_owner_references_owner_idx').on(
      table.workspaceId,
      table.ownerFamily,
      table.ownerId,
      table.ownerSubId,
    ),
    foreignKey({
      name: 'artifact_owner_references_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check('artifact_owner_references_sub_id_valid', sql`owner_sub_id>=0`),
    check(
      'artifact_owner_references_family_valid',
      sql`owner_family in (${sql.join(
        ARTIFACT_OWNER_SOURCES.map((source) => sql.raw(`'${source.table}'`)),
        sql`,`,
      )})`,
    ),
  ],
);
