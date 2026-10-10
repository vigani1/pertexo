import { z } from 'zod';
import {
  parseWorkflowGraphDraft,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model';
import {
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';

import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './records.js';

const uuidSchema = z.uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const workflowVersionRowSelection =
  'id,workspace_id,workflow_id,version_number,graph_json,checksum,published_by,published_at';
export const workflowRowSelection =
  'id,workspace_id,name,name_revision,lifecycle_status,lifecycle_revision,activation_status,published_version_id,created_by,created_at,updated_at';
const checksumSchema = z.string().regex(/^wf:sha256:[0-9a-f]{64}$/u);
const workflowRowSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    name: z.string().trim().min(1).max(128),
    name_revision: revisionSchema,
    lifecycle_status: workflowLifecycleStatusSchema,
    lifecycle_revision: revisionSchema,
    activation_status: workflowActivationStatusSchema,
    published_version_id: uuidSchema.nullable(),
    // ADR 056: operational auto-pause settings and trigger pause state,
    // present when a query selects every column.
    auto_pause_enabled: z.boolean().optional(),
    auto_pause_settings_revision: revisionSchema.optional(),
    auto_pause_threshold: z
      .number()
      .int()
      .min(3)
      .max(100)
      .nullable()
      .optional(),
    trigger_pause_state: z.enum(['none', 'paused']).optional(),
    trigger_paused_at: z.coerce.date().nullable().optional(),
    trigger_pause_reason: z
      .literal('consecutive_failures')
      .nullable()
      .optional(),
    trigger_pause_failures: z.number().int().positive().nullable().optional(),
    trigger_pause_last_run_id: uuidSchema.nullable().optional(),
    // bigint: text from a row query, a number from row_to_json.
    trigger_pause_revision: z
      .union([
        z.string().regex(/^[1-9][0-9]{0,18}$/u),
        z.number().int().positive(),
      ])
      .optional(),
    created_by: uuidSchema,
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
const workflowDraftRowSchema = z
  .object({
    workflow_id: uuidSchema,
    workspace_id: uuidSchema,
    revision: z.number().int().positive(),
    graph_json: z.unknown(),
    updated_by: uuidSchema,
    updated_at: z.coerce.date(),
  })
  .strict();
const workflowVersionRowSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    workflow_id: uuidSchema,
    version_number: z.number().int().positive(),
    graph_json: z.unknown(),
    checksum: checksumSchema,
    published_by: uuidSchema,
    published_at: z.coerce.date(),
  })
  .strict();
export const createdWorkflowRowSchema = z
  .object({ workflow: workflowRowSchema, draft: workflowDraftRowSchema })
  .strict();

export function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
  const parsed = workflowRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    name: parsed.name,
    nameRevision: parsed.name_revision,
    lifecycleStatus: parsed.lifecycle_status,
    lifecycleRevision: parsed.lifecycle_revision,
    activationStatus: parsed.activation_status,
    publishedVersionId: parsed.published_version_id,
    createdBy: parsed.created_by,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapDraft(
  row: Record<string, unknown>,
  definitionCatalog: WorkflowDefinitionCatalog,
): WorkflowDraftRecord {
  const parsed = workflowDraftRowSchema.parse(row);
  const graph = parseWorkflowGraphDraft(parsed.graph_json);
  return Object.freeze({
    workflowId: parsed.workflow_id,
    workspaceId: parsed.workspace_id,
    revision: parsed.revision,
    graphJson: graph,
    compatibility: workflowCompatibilityReport(graph, definitionCatalog),
    updatedBy: parsed.updated_by,
    updatedAt: parsed.updated_at,
  });
}

export function mapVersion(
  row: Record<string, unknown>,
): WorkflowVersionRecord {
  const parsed = workflowVersionRowSchema.parse(row);
  const graph = parseWorkflowGraphDraft(parsed.graph_json);
  return Object.freeze({
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    workflowId: parsed.workflow_id,
    versionNumber: parsed.version_number,
    graphJson: graph,
    checksum: parsed.checksum,
    publishedBy: parsed.published_by,
    publishedAt: parsed.published_at,
  });
}
