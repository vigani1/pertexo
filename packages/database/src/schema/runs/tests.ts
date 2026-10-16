import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { WorkflowTestCompilation } from '@pertexo/workflow-engine';
import { appSchema } from '../namespace.js';
import { workflowRuns } from './execution.js';

/** Preserve the existing value encoding instead of expanding numbers inside JSONB. */
export type FrozenWorkflowTestPins = Readonly<
  Record<string, Readonly<{ sampleId: string; outputRef: string }>>
>;

export const workflowTestSnapshots = appSchema.table(
  'workflow_test_snapshots',
  {
    runId: uuid('run_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    checksum: varchar('checksum', { length: 74 }).notNull(),
    executableJson: jsonb('executable_json').notNull(),
    dispositions: jsonb('dispositions')
      .$type<WorkflowTestCompilation['dispositions']>()
      .notNull(),
    pins: jsonb('pins').$type<FrozenWorkflowTestPins>().notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'workflow_test_snapshots_run_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    check(
      'workflow_test_snapshots_checksum_valid',
      sql`checksum ~ '^wf:sha256:[0-9a-f]{64}$'`,
    ),
    check('workflow_test_snapshots_revision_positive', sql`draft_revision > 0`),
    check(
      'workflow_test_snapshots_graph_bound',
      sql`jsonb_typeof(graph_json)='object' AND octet_length(graph_json::text)<=2097152`,
    ),
    check(
      'workflow_test_snapshots_executable_bound',
      sql`jsonb_typeof(executable_json)='object' AND octet_length(executable_json::text)<=2097152`,
    ),
    check(
      'workflow_test_snapshots_pins_bound',
      sql`jsonb_typeof(pins)='object' AND octet_length(pins::text)<=67108864`,
    ),
  ],
);
