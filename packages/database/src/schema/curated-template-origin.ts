import {
  boolean,
  char,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkflowTemplateOrigin } from '@pertexo/workflow-model/curated-templates';
import { appSchema } from './app-schema.js';
import { workflows } from './authoring.js';

export const curatedTemplateRollout = appSchema.table(
  'curated_template_rollout',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    importEnabled: boolean('import_enabled').notNull().default(false),
  },
);

export const curatedTemplateDescriptors = appSchema.table(
  'curated_template_descriptors',
  {
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    baseManifest: text('base_manifest').notNull(),
    baseManifestDigest: char('base_manifest_digest', { length: 64 }).notNull(),
    setupTargets: jsonb('setup_targets').notNull(),
    supportedProfile: text('supported_profile').notNull(),
    selectionEnabled: boolean('selection_enabled').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.templateVersion] }),
  ],
);

export const workflowTemplateOrigins = appSchema.table(
  'workflow_template_origins',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    origin: jsonb('origin').$type<WorkflowTemplateOrigin>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);
