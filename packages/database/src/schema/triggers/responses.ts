import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { NodeWebhookResponse } from '@pertexo/node-sdk';
import { appSchema } from '../namespace.js';
import { workflowRuns } from '../runs/execution.js';

export const webhookRunResponses = appSchema.table(
  'webhook_run_responses',
  {
    runId: uuid('run_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    waitSeconds: integer('wait_seconds').notNull(),
    statusCode: integer('status_code'),
    contentType: varchar('content_type', { length: 64 }).$type<
      NodeWebhookResponse['contentType']
    >(),
    headers: jsonb('headers').$type<NodeWebhookResponse['headers']>(),
    body: text('body'),
    nodeRunId: uuid('node_run_id'),
    invocationKey: varchar('invocation_key', { length: 256 }),
    respondedAt: timestamp('responded_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    foreignKey({
      name: 'webhook_run_responses_run_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }),
    check(
      'webhook_run_responses_wait_valid',
      sql`wait_seconds BETWEEN 1 AND 30`,
    ),
    check(
      'webhook_run_responses_body_bound',
      sql`octet_length(body) <= 1048576`,
    ),
    check(
      'webhook_run_responses_complete',
      sql`((responded_at IS NULL AND status_code IS NULL AND content_type IS NULL AND headers IS NULL AND body IS NULL AND node_run_id IS NULL AND invocation_key IS NULL) OR (responded_at IS NOT NULL AND status_code BETWEEN 200 AND 599 AND content_type IN ('application/json','text/plain','text/csv','application/xml') AND headers IS NOT NULL AND jsonb_typeof(headers)='object' AND body IS NOT NULL AND node_run_id IS NOT NULL AND invocation_key IS NOT NULL)) IS TRUE`,
    ),
  ],
);
