import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/core/authoring';

import {
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
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

export type WorkflowCreateResult = Awaited<
  ReturnType<typeof serializeWorkflowCreate>
>;
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
) {
  const draft = await serializeWorkflowDraft(input.draft);
  return Object.freeze({
    body: {
      workflow: workflowSummary(input.workflow),
      draft: draft.body,
    },
    representationTag: draft.representationTag,
  });
}

export async function serializeWorkflowDraft(
  draft: WorkflowDraftRecord,
  includeGraphDigest = false,
) {
  const graph = parseWorkflowGraphDraft(draft.graphJson);
  const representation: DraftRepresentation = {
    workflowId: draft.workflowId,
    revision: draft.revision,
    graph,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  };
  return Object.freeze({
    body: {
      workflowId: draft.workflowId,
      revision: draft.revision,
      graph,
      ...(includeGraphDigest
        ? { graphDigest: await portableGraphDigest(graph) }
        : {}),
      compatibility: draft.compatibility,
      updatedAt: draft.updatedAt.toISOString(),
    },
    representationTag: workflowDraftRepresentationTag(representation),
  });
}

export function serializeWorkflowValidation(
  draft: WorkflowDraftRecord,
  validation: ReturnType<typeof validateWorkflowGraph>,
  currentPublication: WorkflowValidateResponse['currentPublication'],
): WorkflowValidationResult {
  // An issue list beyond the contract's bounds can't be reported, so the
  // validation is unavailable; the route's response check covers the rest.
  const issues = workflowValidateResponseSchema.shape.issues.safeParse(
    validation.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    })),
  );
  if (!issues.success)
    throw new AuthoringValidationUnavailableError('report_limit');
  return Object.freeze({
    body: {
      valid: validation.ok && draft.compatibility.compatible,
      issues: issues.data,
      compatibility: {
        ...draft.compatibility,
        issues: [...draft.compatibility.issues],
      },
      currentPublication,
    },
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
  return {
    version: await workflowVersion(version),
    reused,
  };
}

/** What a version read adds on request; older clients decode the default. */
export type VersionAdditions = Readonly<{
  graphDigest: boolean;
  publishedBy: boolean;
}>;

const NO_VERSION_ADDITIONS: VersionAdditions = {
  graphDigest: false,
  publishedBy: false,
};

export async function serializeWorkflowVersions(
  items: readonly WorkflowVersionRecord[],
  nextCursor: string | null,
  additions = NO_VERSION_ADDITIONS,
): Promise<WorkflowVersionsResponse> {
  return {
    items: await Promise.all(
      items.map((version) => workflowVersion(version, additions)),
    ),
    nextCursor,
  };
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
    ...(workflow.pollingTriggers === undefined
      ? {}
      : {
          pollingTriggers: workflow.pollingTriggers.map((trigger) => ({
            id: trigger.id,
            kind: trigger.kind,
            workflowVersionId: trigger.workflowVersionId,
            nodeId: trigger.nodeId,
            healthStatus: trigger.healthStatus,
            lastErrorCode: trigger.lastErrorCode,
            baselineEstablished: trigger.baselineEstablished,
            paused: trigger.paused,
            nextPollAt: trigger.nextPollAt?.toISOString() ?? null,
          })),
        }),
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
  additions = NO_VERSION_ADDITIONS,
): Promise<WorkflowVersionResponse> {
  return workflowVersionResponseSchema.parse({
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    graph: parseWorkflowGraphDraft(version.graphJson),
    ...(additions.graphDigest
      ? { graphDigest: await portableGraphDigest(version.graphJson) }
      : {}),
    checksum: version.checksum,
    publishedAt: version.publishedAt.toISOString(),
    ...(additions.publishedBy
      ? {
          publishedBy: {
            id: version.publishedBy,
            displayName: version.publisherName,
          },
        }
      : {}),
  });
}
