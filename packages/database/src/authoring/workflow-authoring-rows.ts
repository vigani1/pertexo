import { z } from 'zod';
import {
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model/lifecycle';
import {
  parseWorkflowGraphDraft,
  workflowCompatibilityReport,
  workflowRetainedExecutableChecksum,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';

import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './workflow-authoring-records.js';

const uuidSchema = z.uuid();
const retainedChecksumSchema = z.string().regex(/^wf:v1:sha256:[0-9a-f]{64}$/u);
export const workflowVersionRowSelection =
  'id,workspace_id,workflow_id,version_number,schema_version,graph_json,checksum,published_by,published_at';
export const checksumSchema = z.union([
  retainedChecksumSchema,
  z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
]);
const workflowRowSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    name: z.string().trim().min(1).max(128),
    lifecycle_status: workflowLifecycleStatusSchema,
    activation_status: workflowActivationStatusSchema,
    published_version_id: uuidSchema.nullable(),
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
    schema_version: z.literal(1),
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
    schema_version: z.literal(1),
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
    lifecycleStatus: parsed.lifecycle_status,
    activationStatus: parsed.activation_status,
    publishedVersionId: parsed.published_version_id,
    createdBy: parsed.created_by,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function mapDraft(
  row: Record<string, unknown>,
  definitionCatalog: WorkflowDefinitionCatalogV1,
): WorkflowDraftRecord {
  const parsed = workflowDraftRowSchema.parse(row);
  const graph = parseWorkflowGraphDraft(parsed.graph_json);
  return Object.freeze({
    workflowId: parsed.workflow_id,
    workspaceId: parsed.workspace_id,
    revision: parsed.revision,
    schemaVersion: parsed.schema_version,
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
  if (parsed.schema_version !== graph.schemaVersion) {
    throw new Error('Stored workflow version schema does not match its graph');
  }
  if (
    retainedChecksumSchema.safeParse(parsed.checksum).success &&
    parsed.checksum !== workflowRetainedExecutableChecksum(graph)
  ) {
    throw new Error(
      'Stored workflow version checksum does not match its graph',
    );
  }
  return Object.freeze({
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    workflowId: parsed.workflow_id,
    versionNumber: parsed.version_number,
    schemaVersion: parsed.schema_version,
    graphJson: graph,
    checksum: parsed.checksum,
    publishedBy: parsed.published_by,
    publishedAt: parsed.published_at,
  });
}
