import type { WorkflowGraph } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  json,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { WorkflowTestCompilation } from '@pertexo/workflow-engine';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';

/** Preserve the existing value encoding instead of expanding numbers inside JSONB. */
export type FrozenWorkflowTestPins = Readonly<
  Record<string, Readonly<{ sampleId: string; outputRef: string }>>
>;

export const workflowTestSnapshots = appSchema.table(
  'workflow_test_snapshots',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    graphJson: json('graph_json').$type<WorkflowGraph>().notNull(),
    checksum: varchar('checksum', { length: 74 }).notNull(),
    executableJson: json('executable_json').notNull(),
    dispositions: jsonb('dispositions')
      .$type<WorkflowTestCompilation['dispositions']>()
      .notNull(),
    pins: json('pins').$type<FrozenWorkflowTestPins>().notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'workflow_test_snapshots_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    unique('workflow_test_snapshots_workspace_id_key').on(
      table.workspaceId,
      table.id,
    ),
    check(
      'workflow_test_snapshots_checksum_valid',
      sql`checksum ~ '^wf:sha256:[0-9a-f]{64}$'`,
    ),
    check('workflow_test_snapshots_revision_positive', sql`draft_revision > 0`),
    check(
      'workflow_test_snapshots_graph_bound',
      sql`json_typeof(graph_json)='object' AND octet_length(graph_json::text)<=2097152`,
    ),
    check(
      'workflow_test_snapshots_executable_bound',
      sql`json_typeof(executable_json)='object' AND octet_length(executable_json::text)<=2097152`,
    ),
    check(
      'workflow_test_snapshots_pins_bound',
      sql`json_typeof(pins)='object' AND octet_length(pins::text)<=67108864`,
    ),
  ],
);
