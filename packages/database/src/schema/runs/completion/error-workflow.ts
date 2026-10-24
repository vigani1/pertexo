import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workflowRuns } from '../execution.js';
import { workflowVersions } from '../../authoring/workflows.js';

export const runErrorWorkflowIntents = appSchema.table(
  'run_error_workflow_intents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    targetWorkflowId: uuid('target_workflow_id').notNull(),
    targetVersionId: uuid('target_version_id'),
    context: jsonb().notNull(),
    outboxEventId: uuid('outbox_event_id'),
    status: varchar({ length: 16 })
      .$type<WorkflowRunErrorWorkflow['status']>()
      .notNull()
      .default('pending'),
    acceptedRunId: uuid('accepted_run_id'),
    refusalCode: varchar('refusal_code', { length: 64 }).$type<
      NonNullable<WorkflowRunErrorWorkflow['refusalCode']>
    >(),
    queueWaitExpiresAt: timestamp('queue_wait_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.sourceRunId] }),
    check(
      'run_error_workflow_intents_context_bounded',
      sql`jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 8192`,
    ),
    check(
      'run_error_workflow_intents_state_valid',
      sql`((status = 'pending' AND accepted_run_id IS NULL AND refusal_code IS NULL AND completed_at IS NULL) OR (status = 'accepted' AND accepted_run_id IS NOT NULL AND refusal_code IS NULL AND completed_at IS NOT NULL) OR (status = 'refused' AND accepted_run_id IS NULL AND refusal_code IN ('target_unavailable','workspace_unavailable','queue_full','invalid_target','target_not_published','concurrency_limit') AND completed_at IS NOT NULL)) IS TRUE`,
    ),
    check(
      'run_error_workflow_intents_target_valid',
      sql`(CASE WHEN refusal_code = 'target_not_published' THEN status = 'refused' AND target_version_id IS NULL AND outbox_event_id IS NULL ELSE target_version_id IS NOT NULL AND outbox_event_id IS NOT NULL END) IS TRUE`,
    ),
    foreignKey({
      name: 'run_error_workflow_intents_source_fk',
      columns: [table.workspaceId, table.sourceRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_error_workflow_intents_version_fk',
      columns: [
        table.workspaceId,
        table.targetWorkflowId,
        table.targetVersionId,
      ],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    index('run_error_workflow_intents_target_idx').on(
      table.workspaceId,
      table.targetVersionId,
    ),
  ],
);
