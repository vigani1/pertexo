import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';

import {
  EMPTY_WORKFLOW_GRAPH_V1,
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from './graph.js';

import {
  authorizeWorkspace,
  type AuthorizationCapability,
} from '../workspaces/index.js';
import {
  createDraftRepresentationTag,
  type DraftRepresentation,
} from './etag.js';
import {
  WORKFLOW_AUTHORING_OPERATION,
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';
import {
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowListResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsResponseSchema,
  type WorkflowCreateResponse,
  type WorkflowDraftResponse,
  type WorkflowPublishResponse,
  type WorkflowSummary,
} from './types.js';
import type {
  WorkflowAuthoringPersistence,
  WorkflowApplicationInput,
} from './ports.js';
import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/database/api';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/api';

export type WorkflowDraftResult = Readonly<{
  body: WorkflowDraftResponse;
  representationTag: string;
}>;
export type WorkflowCreateResult = Readonly<{
  body: WorkflowCreateResponse;
  representationTag: string;
}>;

export type ListWorkflowsInput = WorkflowApplicationInput &
  Readonly<{ limit?: number; after?: string }>;
export type CreateWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    name: string;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
export type WorkflowResourceInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string }>;
export type SaveWorkflowDraftInput = WorkflowResourceInput &
  Readonly<{
    representationTag: string;
    graph: unknown;
    requestId?: string;
    traceId?: string;
  }>;
export type PublishWorkflowInput = WorkflowResourceInput &
  Readonly<{
    representationTag: string;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;
export type ListWorkflowVersionsInput = WorkflowResourceInput &
  Readonly<{ limit?: number; after?: string }>;

export class InvalidWorkflowCursorError extends TypeError {
  public override readonly name = 'InvalidWorkflowCursorError';
  public constructor() {
    super('workflow cursor is invalid');
  }
}

const ACTIVE_WORKFLOW_CAPABILITY = 'workflow:read' as const;

export class ListWorkflowsUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: ListWorkflowsInput): Promise<WorkflowListResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.list,
      async () => {
        await authorize(input, ACTIVE_WORKFLOW_CAPABILITY, this.authorization);
        const page = await this.persistence.listWorkflows({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined
            ? {}
            : { after: decodeWorkflowCursor(input.after) }),
        });
        const items = page.items.map(toWorkflowSummary);
        const nextCursor =
          page.nextCursor === undefined
            ? null
            : encodeWorkflowCursor(page.nextCursor);
        return workflowListResponseSchema.parse({ items, nextCursor });
      },
    );
  }
}

export type WorkflowListResult = Readonly<{
  items: readonly WorkflowSummary[];
  nextCursor: string | null;
}>;

export class CreateWorkflowUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: CreateWorkflowInput): Promise<WorkflowCreateResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.create,
      async () => {
        await authorize(input, 'workflow:create', this.authorization);
        const request = workflowCreateRequestSchema.parse({ name: input.name });
        const created = await this.persistence.createWorkflow({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          name: request.name,
          emptyGraph: EMPTY_WORKFLOW_GRAPH_V1,
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
        const draft = toDraft(created.draft);
        return Object.freeze({
          body: workflowCreateResponseSchema.parse({
            workflow: toWorkflowSummary(created.workflow),
            draft: draft.body,
          }),
          representationTag: draft.representationTag,
        });
      },
    );
  }
}

export class GetWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: WorkflowResourceInput): Promise<WorkflowDraftResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.draftGet,
      async () => {
        await authorize(input, ACTIVE_WORKFLOW_CAPABILITY, this.authorization);
        const draft = await this.persistence.getDraft(
          input.routeWorkspaceId,
          input.workflowId,
          input.actor.actorId,
        );
        if (draft === null)
          throw new WorkflowNotFoundError('Workflow is not visible');
        return toDraft(draft);
      },
    );
  }
}

export class SaveWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: SaveWorkflowDraftInput): Promise<WorkflowDraftResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.draftSave,
      async () => {
        await authorize(input, 'workflow:update', this.authorization);
        const graph = parseWorkflowGraphDraft(input.graph);
        const current = await this.currentDraft(input);
        const currentTag = toDraft(current).representationTag;
        if (currentTag !== input.representationTag)
          throw revisionConflict(current, currentTag);
        try {
          const saved = await this.persistence.saveDraft({
            workspaceId: input.routeWorkspaceId,
            workflowId: input.workflowId,
            actorId: input.actor.actorId,
            expectedRevision: current.revision,
            graphJson: graph,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          });
          return toDraft(saved);
        } catch (error: unknown) {
          if (!(error instanceof WorkflowRevisionConflictError)) throw error;
          // The persistence CAS conflict contains the revision and strong
          // representation tag read by the same failed transaction. A second
          // draft read could observe a later save and pair mismatched values.
          throw error;
        }
      },
    );
  }

  private async currentDraft(
    input: WorkflowResourceInput,
  ): Promise<WorkflowDraftRecord> {
    const draft = await this.persistence.getDraft(
      input.routeWorkspaceId,
      input.workflowId,
      input.actor.actorId,
    );
    if (draft === null)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return draft;
  }
}

export class ValidateWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: WorkflowResourceInput): Promise<unknown> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.validate,
      async () => {
        await authorize(input, ACTIVE_WORKFLOW_CAPABILITY, this.authorization);
        const draft = await this.persistence.getDraft(
          input.routeWorkspaceId,
          input.workflowId,
          input.actor.actorId,
        );
        if (draft === null)
          throw new WorkflowNotFoundError('Workflow is not visible');
        const graph = parseWorkflowGraphDraft(draft.graphJson);
        const validation = validateWorkflowGraph(graph);
        return workflowValidateResponseSchema.parse({
          valid: validation.ok && draft.compatibility.compatible,
          issues: validation.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
          compatibility: draft.compatibility,
        });
      },
    );
  }
}

export class PublishWorkflowUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: PublishWorkflowInput,
  ): Promise<WorkflowPublishResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.publish,
      async () => {
        await authorize(input, 'workflow:publish', this.authorization);
        // The opaque If-Match is handed to persistence without a preliminary
        // draft read. Persistence must resolve an exact idempotent replay
        // before looking up the current draft or evaluating the tag.
        const result = await this.persistence.publishWorkflow({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          representationTag: input.representationTag,
          requestHash: publishRequestHash(input),
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        });
        return workflowPublishResponseSchema.parse({
          version: toVersion(result.version),
          reused: result.reused,
        });
      },
    );
  }
}

export class ListWorkflowVersionsUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: Parameters<
      typeof authorizeWorkspace
    >[0]['access'],
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: ListWorkflowVersionsInput): Promise<unknown> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.versionsList,
      async () => {
        await authorize(input, ACTIVE_WORKFLOW_CAPABILITY, this.authorization);
        const page = await this.persistence.listVersions({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined
            ? {}
            : { beforeVersionNumber: decodeVersionCursor(input.after) }),
        });
        return workflowVersionsResponseSchema.parse({
          items: page.items.map(toVersion),
          nextCursor:
            page.nextCursor === undefined
              ? null
              : encodeVersionCursor(page.nextCursor.beforeVersionNumber),
        });
      },
    );
  }
}

export function toDraft(draft: WorkflowDraftRecord): WorkflowDraftResult {
  const graph = parseWorkflowGraphDraft(draft.graphJson);
  const body = workflowDraftResponseSchema.parse({
    workflowId: draft.workflowId,
    revision: draft.revision,
    schemaVersion: draft.schemaVersion,
    graph,
    compatibility: draft.compatibility,
    updatedAt: draft.updatedAt.toISOString(),
  });
  const representation: DraftRepresentation = {
    workflowId: draft.workflowId,
    revision: draft.revision,
    schemaVersion: draft.schemaVersion,
    graph,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  };
  return Object.freeze({
    body,
    representationTag: createDraftRepresentationTag(representation),
  });
}

function toWorkflowSummary(workflow: WorkflowRecord): WorkflowSummary {
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    lifecycleStatus: workflow.lifecycleStatus,
    activationStatus: workflow.activationStatus,
    publishedVersionId: workflow.publishedVersionId,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function toVersion(version: WorkflowVersionRecord): unknown {
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

function revisionConflict(
  draft: WorkflowDraftRecord,
  currentEtag: string,
): WorkflowRevisionConflictError {
  return new WorkflowRevisionConflictError(draft.revision, currentEtag);
}

async function authorize(
  input: WorkflowApplicationInput,
  capability: AuthorizationCapability,
  access: Parameters<typeof authorizeWorkspace>[0]['access'],
): Promise<void> {
  await authorizeWorkspace({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
  });
}

function publishRequestHash(input: PublishWorkflowInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.publish-request',
        version: 1,
        actorId: input.actor.actorId,
        workspaceId: input.routeWorkspaceId,
        workflowId: input.workflowId,
        representationTag: input.representationTag,
      }),
    )
    .digest('hex');
}

function encodeWorkflowCursor(
  cursor: Readonly<{ createdAt: Date; id: string }>,
): string {
  return Buffer.from(
    JSON.stringify({
      kind: 'workflow',
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeWorkflowCursor(
  value: string,
): Readonly<{ createdAt: Date; id: string }> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('kind' in parsed) ||
      parsed.kind !== 'workflow' ||
      !('createdAt' in parsed) ||
      typeof parsed.createdAt !== 'string' ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string'
    )
      throw new Error('invalid workflow cursor');
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime()))
      throw new Error('invalid workflow cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new InvalidWorkflowCursorError();
  }
}

function encodeVersionCursor(versionNumber: number): string {
  return Buffer.from(
    JSON.stringify({ kind: 'versions', beforeVersionNumber: versionNumber }),
    'utf8',
  ).toString('base64url');
}

function decodeVersionCursor(value: string): number {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('kind' in parsed) ||
      parsed.kind !== 'versions' ||
      !('beforeVersionNumber' in parsed) ||
      typeof parsed.beforeVersionNumber !== 'number' ||
      !Number.isInteger(parsed.beforeVersionNumber) ||
      parsed.beforeVersionNumber < 1
    )
      throw new Error('invalid version cursor');
    return parsed.beforeVersionNumber;
  } catch {
    throw new InvalidWorkflowCursorError();
  }
}
