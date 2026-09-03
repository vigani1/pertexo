import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';

import {
  EMPTY_WORKFLOW_GRAPH_V1,
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from './graph.js';

import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import {
  decodeVersionCursor,
  decodeWorkflowCursor,
  encodeVersionCursor,
  encodeWorkflowCursor,
  InvalidWorkflowCursorError,
} from './cursor.js';
import {
  WORKFLOW_AUTHORING_OPERATION,
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';
import {
  workflowCreateRequestSchema,
  type WorkflowPublishResponse,
  type WorkflowSummary,
  type WorkflowValidateResponse,
  type WorkflowVersionsResponse,
} from './types.js';
import type {
  WorkflowAuthoringPersistence,
  WorkflowApplicationInput,
} from './ports.js';
import type { WorkflowDraftRecord } from '@pertexo/database/api';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/api';

import {
  serializeWorkflowCreate,
  serializeWorkflowDraft,
  serializeWorkflowList,
  serializeWorkflowPublication,
  serializeWorkflowValidation,
  serializeWorkflowVersions,
  type WorkflowCreateResult,
  type WorkflowDraftResult,
} from './serializers.js';

export type { WorkflowCreateResult, WorkflowDraftResult };

export type ListWorkflowsInput = WorkflowApplicationInput &
  Readonly<{ limit?: number; after?: string }>;
export type CreateWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    request: unknown;
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

export { InvalidWorkflowCursorError };

const ACTIVE_WORKFLOW_CAPABILITY = 'workflow:read' as const;

export class ListWorkflowsUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
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
        const nextCursor =
          page.nextCursor === undefined
            ? null
            : encodeWorkflowCursor(page.nextCursor);
        return serializeWorkflowList(page.items, nextCursor);
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
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: CreateWorkflowInput): Promise<WorkflowCreateResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.create,
      async () => {
        await authorize(input, 'workflow:create', this.authorization);
        const request = workflowCreateRequestSchema.parse(input.request);
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
        return serializeWorkflowCreate(created);
      },
    );
  }
}

export class GetWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
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
        return serializeWorkflowDraft(draft);
      },
    );
  }
}

export class SaveWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: SaveWorkflowDraftInput): Promise<WorkflowDraftResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.draftSave,
      async () => {
        await authorize(input, 'workflow:update', this.authorization);
        const graph = parseWorkflowGraphDraft(input.graph);
        const current = await this.currentDraft(input);
        const currentTag = serializeWorkflowDraft(current).representationTag;
        if (currentTag !== input.representationTag)
          throw revisionConflict(current, currentTag);
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
        return serializeWorkflowDraft(saved);
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
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: WorkflowResourceInput,
  ): Promise<WorkflowValidateResponse> {
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
        return serializeWorkflowValidation(draft, validation);
      },
    );
  }
}

export class PublishWorkflowUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
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
        return serializeWorkflowPublication(result.version, result.reused);
      },
    );
  }
}

export class ListWorkflowVersionsUseCase {
  public constructor(
    private readonly persistence: WorkflowAuthoringPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: ListWorkflowVersionsInput,
  ): Promise<WorkflowVersionsResponse> {
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
        return serializeWorkflowVersions(
          page.items,
          page.nextCursor === undefined
            ? null
            : encodeVersionCursor(page.nextCursor.beforeVersionNumber),
        );
      },
    );
  }
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
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
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
