import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  timestamp,
  type PgTableExtraConfigValue,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { workflowRuns } from './workflow-runs.js';

export const runCheckpoints = appSchema.table(
  'run_checkpoints',
  {
    workflowRunId: uuid('workflow_run_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    revision: integer('revision').notNull(),
    schedulerState: jsonb('scheduler_state').notNull(),
    resumeAt: timestamp('resume_at', { withTimezone: true, mode: 'date' }),
    resumeLeaseOwner: varchar('resume_lease_owner', { length: 128 }),
    resumeLeaseToken: uuid('resume_lease_token'),
    resumeLeaseExpiresAt: timestamp('resume_lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'run_checkpoints_resume_lease_complete',
      sql`(((resume_lease_owner IS NULL) AND (resume_lease_token IS NULL) AND (resume_lease_expires_at IS NULL)) OR ((resume_lease_owner IS NOT NULL) AND (resume_lease_token IS NOT NULL) AND (resume_lease_expires_at IS NOT NULL)))`,
    ),
    check('run_checkpoints_revision_nonnegative', sql`(revision >= 0)`),
    check(
      'run_checkpoints_scheduler_state_bounded',
      sql`(octet_length((scheduler_state)::text) <= 4194304)`,
    ),
    foreignKey({
      name: 'run_checkpoints_run_version_workspace_fk',
      columns: [
        table.workspaceId,
        table.workflowRunId,
        table.workflowVersionId,
      ],
      foreignColumns: [
        workflowRuns.workspaceId,
        workflowRuns.id,
        workflowRuns.workflowVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_checkpoints_run_workspace_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    index('run_checkpoints_due_resume_idx')
      .on(table.resumeAt, table.workflowRunId)
      .where(sql`(resume_at IS NOT NULL)`),
  ],
);
