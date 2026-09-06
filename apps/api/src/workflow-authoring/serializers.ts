import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/database/api';

import {
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowListResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsResponseSchema,
  type WorkflowPublishResponse,
  type WorkflowSummary,
  type WorkflowValidateResponse,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
} from './types.js';
import { parseWorkflowGraphDraft } from './graph.js';
import type { validateWorkflowGraph } from './graph.js';
import {
  createDraftRepresentationTag,
  type DraftRepresentation,
} from './etag.js';

export type WorkflowDraftResult = Readonly<{
  body: ReturnType<typeof workflowDraftResponseSchema.parse>;
  representationTag: string;
}>;

export type WorkflowCreateResult = Readonly<{
  body: ReturnType<typeof workflowCreateResponseSchema.parse>;
  representationTag: string;
}>;

export function serializeWorkflowList(
  items: readonly WorkflowRecord[],
  nextCursor: string | null,
): Readonly<{ items: readonly WorkflowSummary[]; nextCursor: string | null }> {
  return workflowListResponseSchema.parse({
    items: items.map(workflowSummary),
    nextCursor,
  });
}

export function serializeWorkflowCreate(
  input: Readonly<{
    workflow: WorkflowRecord;
    draft: WorkflowDraftRecord;
  }>,
): WorkflowCreateResult {
  const draft = serializeWorkflowDraft(input.draft);
  return Object.freeze({
    body: workflowCreateResponseSchema.parse({
      workflow: workflowSummary(input.workflow),
      draft: draft.body,
    }),
    representationTag: draft.representationTag,
  });
}

export function serializeWorkflowDraft(
  draft: WorkflowDraftRecord,
): WorkflowDraftResult {
  const graph = parseWorkflowGraphDraft(draft.graphJson);
  const representation: DraftRepresentation = {
    workflowId: draft.workflowId,
    revision: draft.revision,
    schemaVersion: draft.schemaVersion,
    graph,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  };
  return Object.freeze({
    body: workflowDraftResponseSchema.parse({
      workflowId: draft.workflowId,
      revision: draft.revision,
      schemaVersion: draft.schemaVersion,
      graph,
      compatibility: draft.compatibility,
      updatedAt: draft.updatedAt.toISOString(),
    }),
    representationTag: createDraftRepresentationTag(representation),
  });
}

export function serializeWorkflowValidation(
  draft: WorkflowDraftRecord,
  validation: ReturnType<typeof validateWorkflowGraph>,
): WorkflowValidateResponse {
  return workflowValidateResponseSchema.parse({
    valid: validation.ok && draft.compatibility.compatible,
    issues: validation.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    })),
    compatibility: draft.compatibility,
  });
}

export function serializeWorkflowPublication(
  version: WorkflowVersionRecord,
  reused: boolean,
): WorkflowPublishResponse {
  return workflowPublishResponseSchema.parse({
    version: workflowVersion(version),
    reused,
  });
}

export function serializeWorkflowVersions(
  items: readonly WorkflowVersionRecord[],
  nextCursor: string | null,
): WorkflowVersionsResponse {
  return workflowVersionsResponseSchema.parse({
    items: items.map(workflowVersion),
    nextCursor,
  });
}

export function workflowSummary(workflow: WorkflowRecord): WorkflowSummary {
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    lifecycleStatus: workflow.lifecycleStatus,
    lifecycleRevision: workflow.lifecycleRevision,
    activationStatus: workflow.activationStatus,
    publishedVersionId: workflow.publishedVersionId,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function workflowVersion(
  version: WorkflowVersionRecord,
): WorkflowVersionResponse {
  return workflowVersionResponseSchema.parse({
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    schemaVersion: version.schemaVersion,
    graph: parseWorkflowGraphDraft(version.graphJson),
    checksum: version.checksum,
    publishedAt: version.publishedAt.toISOString(),
  });
}
