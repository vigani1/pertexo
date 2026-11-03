import { parseWorkflowGraphDraft } from './graph.js';
import type { WorkspaceAuthorizationSource } from '../authorization/index.js';
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
import type { WorkflowSummary, WorkflowVersionsResponse } from './types.js';
import type { WorkflowApplicationInput } from './ports.js';
import type { WorkflowDraftRecord } from '@pertexo/core/authoring';
import { WorkflowNotFoundError } from '@pertexo/core/authoring';
import {
  serializeWorkflowDraft,
  serializeWorkflowList,
  serializeWorkflowSummary,
  serializeWorkflowValidation,
  serializeWorkflowVersions,
  type WorkflowDraftResult,
  type WorkflowValidationResult,
} from './http/serializers.js';
import { createDraftRepresentationTag } from './http/etag.js';
import { workflowTemplateOriginProjectionResponseSchema } from '@pertexo/contracts';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  authorizeWorkflowRead,
  type AuthoringPersistence,
  revisionConflict,
  authorize,
} from './commands/authorization.js';
export { InvalidWorkflowCursorError };
export {
  type CreateWorkflowInput,
  CreateWorkflowUseCase,
} from './commands/create.js';
export {
  type PublishWorkflowInput,
  PublishWorkflowUseCase,
} from './publication/publish.js';
export type ListWorkflowsInput = WorkflowApplicationInput &
  Readonly<{
    limit?: number;
    after?: string;
    order?: 'created_asc' | 'updated_desc';
    pinsWorkflowId?: string;
  }>;

export type WorkflowResourceInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string; signal?: AbortSignal }>;

export type SaveWorkflowDraftInput = WorkflowResourceInput &
  Readonly<{
    representationTag: string;
    graph: unknown;
    requestId?: string;
    traceId?: string;
  }>;

export type ListWorkflowVersionsInput = WorkflowResourceInput &
  Readonly<{ limit?: number; after?: string; versionId?: string }>;

export class ListWorkflowsUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<'listWorkflows'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: ListWorkflowsInput): Promise<WorkflowListResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.list,
      async () => {
        await authorizeWorkflowRead(input, this.authorization);
        const page = await this.persistence.listWorkflows({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          ...(input.pinsWorkflowId === undefined
            ? {}
            : { pinsWorkflowId: input.pinsWorkflowId }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined
            ? {}
            : {
                after: decodeWorkflowCursor(
                  input.after,
                  input.order,
                  input.pinsWorkflowId,
                ),
              }),
          ...(input.order === undefined ? {} : { order: input.order }),
        });
        const nextCursor =
          page.nextCursor === undefined
            ? null
            : encodeWorkflowCursor(
                page.nextCursor,
                input.order,
                input.pinsWorkflowId,
              );
        return serializeWorkflowList(page.items, nextCursor);
      },
    );
  }
}

export type WorkflowListResult = Readonly<{
  items: readonly WorkflowSummary[];
  nextCursor: string | null;
}>;

export class GetWorkflowUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<
      'getWorkflow' | 'getWorkflowWithTemplateOrigin'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: WorkflowResourceInput & Readonly<{ include?: 'templateOrigin' }>,
  ) {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.list,
      async () => {
        await authorizeWorkflowRead(input, this.authorization);
        if (input.include === 'templateOrigin') {
          if (this.persistence.getWorkflowWithTemplateOrigin === undefined)
            return throwApplicationError(
              applicationError('workflow.template_origin_unavailable', {
                safeDetail:
                  'Historical template origin is temporarily unavailable.',
              }),
            );
          const projection =
            await this.persistence.getWorkflowWithTemplateOrigin(
              input.routeWorkspaceId,
              input.workflowId,
              input.actor.actorId,
            );
          if (projection === null)
            throw new WorkflowNotFoundError('Workflow is not visible');
          return workflowTemplateOriginProjectionResponseSchema.parse({
            workflow: serializeWorkflowSummary(projection.workflow).workflow,
            templateOrigin: projection.templateOrigin,
          });
        }
        const workflow = await this.persistence.getWorkflow(
          input.routeWorkspaceId,
          input.workflowId,
          input.actor.actorId,
        );
        if (workflow === null)
          throw new WorkflowNotFoundError('Workflow is not visible');
        return serializeWorkflowSummary(workflow);
      },
    );
  }
}

export class GetWorkflowDraftUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<'getDraft'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: WorkflowResourceInput): Promise<WorkflowDraftResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.draftGet,
      async () => {
        await authorizeWorkflowRead(input, this.authorization);
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
    private readonly persistence: AuthoringPersistence<
      'saveDraft' | 'getDraft'
    >,
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
        const currentTag = createDraftRepresentationTag({
          workflowId: current.workflowId,
          revision: current.revision,
          graph: current.graphJson,
          compatibilityFingerprint: current.compatibility.fingerprint,
        });
        if (currentTag !== input.representationTag)
          throw revisionConflict(current, currentTag);
        const saved = await this.persistence.saveDraft({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          representationTag: input.representationTag,
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
    private readonly persistence: AuthoringPersistence<'validateDraft'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: WorkflowResourceInput,
  ): Promise<WorkflowValidationResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.validate,
      async () => {
        await authorizeWorkflowRead(input, this.authorization);
        const result = await this.persistence.validateDraft(
          input.routeWorkspaceId,
          input.workflowId,
          input.actor.actorId,
          input.signal === undefined ? {} : { signal: input.signal },
        );
        if (result === null)
          throw new WorkflowNotFoundError('Workflow is not visible');
        return serializeWorkflowValidation(
          result.draft,
          result.validation,
          result.currentPublication,
        );
      },
    );
  }
}

export class ListWorkflowVersionsUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<'listVersions'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: ListWorkflowVersionsInput,
  ): Promise<WorkflowVersionsResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.versionsList,
      async () => {
        await authorizeWorkflowRead(input, this.authorization);
        const page = await this.persistence.listVersions({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          ...(input.versionId === undefined
            ? {}
            : { versionId: input.versionId }),
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
