import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/core/authoring';

import {
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsResponseSchema,
  type WorkflowPublishResponse,
  type WorkflowSummary,
  type WorkflowValidateResponse,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
} from '@pertexo/contracts';
import {
  portableGraphDigest,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import type { validateWorkflowGraph } from '@pertexo/workflow-model';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
type DraftRepresentation = Parameters<typeof workflowDraftRepresentationTag>[0];

export type WorkflowDraftResult = Readonly<{
  body: ReturnType<typeof workflowDraftResponseSchema.parse>;
  representationTag: string;
}>;

export type WorkflowCreateResult = Readonly<{
  body: ReturnType<typeof workflowCreateResponseSchema.parse>;
  representationTag: string;
}>;
export type WorkflowValidationResult = Readonly<{
  body: WorkflowValidateResponse;
  representationTag: string;
}>;

export function serializeWorkflowList(
  items: readonly WorkflowRecord[],
  nextCursor: string | null,
  projection?: Readonly<{ recentRuns: boolean }>,
): Readonly<{ items: readonly WorkflowSummary[]; nextCursor: string | null }> {
  return workflowListResponseSchema.parse({
    items: items.map((item) => workflowSummary(item, projection)),
    nextCursor,
  });
}

export function serializeWorkflowSummary(
  workflow: WorkflowRecord,
  projection?: Readonly<{ recentRuns: boolean }>,
) {
  return workflowSummaryResponseSchema.parse({
    workflow: workflowSummary(workflow, projection),
  });
}

export async function serializeWorkflowCreate(
  input: Readonly<{
    workflow: WorkflowRecord;
    draft: WorkflowDraftRecord;
  }>,
): Promise<WorkflowCreateResult> {
  const draft = await serializeWorkflowDraft(input.draft);
  return Object.freeze({
    body: workflowCreateResponseSchema.parse({
      workflow: workflowSummary(input.workflow),
      draft: draft.body,
    }),
    representationTag: draft.representationTag,
  });
}

export async function serializeWorkflowDraft(
  draft: WorkflowDraftRecord,
  includeGraphDigest = false,
): Promise<WorkflowDraftResult> {
  const graph = parseWorkflowGraphDraft(draft.graphJson);
  const representation: DraftRepresentation = {
    workflowId: draft.workflowId,
    revision: draft.revision,
    graph,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  };
  return Object.freeze({
    body: workflowDraftResponseSchema.parse({
      workflowId: draft.workflowId,
      revision: draft.revision,
      graph,
      ...(includeGraphDigest
        ? { graphDigest: await portableGraphDigest(graph) }
        : {}),
      compatibility: draft.compatibility,
      updatedAt: draft.updatedAt.toISOString(),
    }),
    representationTag: workflowDraftRepresentationTag(representation),
  });
}

export function serializeWorkflowValidation(
  draft: WorkflowDraftRecord,
  validation: ReturnType<typeof validateWorkflowGraph>,
  currentPublication: WorkflowValidateResponse['currentPublication'],
): WorkflowValidationResult {
  const parsed = workflowValidateResponseSchema.safeParse({
    valid: validation.ok && draft.compatibility.compatible,
    issues: validation.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    })),
    compatibility: draft.compatibility,
    currentPublication,
  });
  if (!parsed.success)
    throw new AuthoringValidationUnavailableError('report_limit');
  return Object.freeze({
    body: parsed.data,
    representationTag: workflowDraftRepresentationTag({
      workflowId: draft.workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
  });
}

export async function serializeWorkflowPublication(
  version: WorkflowVersionRecord,
  { reused }: Readonly<{ reused: boolean }>,
): Promise<WorkflowPublishResponse> {
  return workflowPublishResponseSchema.parse({
    version: await workflowVersion(version),
    reused,
  });
}

export async function serializeWorkflowVersions(
  items: readonly WorkflowVersionRecord[],
  nextCursor: string | null,
  includeGraphDigest = false,
): Promise<WorkflowVersionsResponse> {
  return workflowVersionsResponseSchema.parse({
    items: await Promise.all(
      items.map((version) => workflowVersion(version, includeGraphDigest)),
    ),
    nextCursor,
  });
}

export function workflowSummary(
  workflow: WorkflowRecord,
  projection?: Readonly<{ recentRuns: boolean }>,
): WorkflowSummary {
  return {
    ...(projection === undefined || workflow.listSummary === undefined
      ? {}
      : {
          listSummary: {
            shape: workflow.listSummary.shape,
            ...(projection.recentRuns &&
            workflow.listSummary.recentRuns !== undefined
              ? { recentRuns: workflow.listSummary.recentRuns }
              : {}),
          },
        }),
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    nameRevision: workflow.nameRevision,
    lifecycleStatus: workflow.lifecycleStatus,
    lifecycleRevision: workflow.lifecycleRevision,
    activationStatus: workflow.activationStatus,
    webhookSetupRequired: workflow.webhookSetupRequired,
    ...(workflow.resourceAccess === undefined
      ? {}
      : { resourceAccess: workflow.resourceAccess }),
    publishedVersionId: workflow.publishedVersionId,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

async function workflowVersion(
  version: WorkflowVersionRecord,
  includeGraphDigest = false,
): Promise<WorkflowVersionResponse> {
  return workflowVersionResponseSchema.parse({
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    graph: parseWorkflowGraphDraft(version.graphJson),
    ...(includeGraphDigest
      ? { graphDigest: await portableGraphDigest(version.graphJson) }
      : {}),
    checksum: version.checksum,
    publishedAt: version.publishedAt.toISOString(),
  });
}
