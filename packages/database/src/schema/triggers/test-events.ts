import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { WebhookAuthentication } from '@pertexo/contracts';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';

export const webhookTestEvents = appSchema.table(
  'webhook_test_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 64 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    endpointKeyHash: char('endpoint_key_hash', { length: 64 }).notNull(),
    binding: text('binding').notNull(),
    authentication: jsonb('authentication')
      .$type<WebhookAuthentication>()
      .notNull(),
    kmsKeyReference: varchar('kms_key_reference', { length: 2048 }).notNull(),
    encryptedDataKey: text('encrypted_data_key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    outputRef: text('output_ref'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => [
    unique('webhook_test_events_key').on(t.endpointKeyHash),
    unique('webhook_test_events_workflow').on(t.workspaceId, t.workflowId),
    foreignKey({
      name: 'webhook_test_events_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    check(
      'webhook_test_events_hash_valid',
      sql`endpoint_key_hash ~ '^[0-9a-f]{64}$'`,
    ),
    check('webhook_test_events_attempts_valid', sql`attempts between 0 and 60`),
    check(
      'webhook_test_events_output_valid',
      sql`(output_ref IS NULL AND received_at IS NULL) OR (output_ref IS NOT NULL AND received_at IS NOT NULL AND octet_length(output_ref)<=262200 AND output_ref::jsonb->>'kind'='inline')`,
    ),
    check('webhook_test_events_expiry_valid', sql`expires_at > created_at`),
    index('webhook_test_events_expiry_idx').on(t.expiresAt, t.id),
  ],
);
