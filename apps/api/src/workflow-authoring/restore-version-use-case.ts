import { workflowVersionRestoreRequestSchema } from '@pertexo/contracts/workflow-authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from './ports.js';
import {
  serializeWorkflowDraft,
  type WorkflowDraftResult,
} from './serializers.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';

export type RestoreWorkflowVersionInput = WorkflowApplicationInput &
  Readonly<{
    workflowId: string;
    versionId: string;
    representationTag: string;
    request: unknown;
  }>;

/** Source identity, current tag and draft mutation share database authority. */
export class RestoreWorkflowVersionUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowAuthoringPersistence,
      'restoreWorkflowVersion'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: RestoreWorkflowVersionInput,
  ): Promise<WorkflowDraftResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.versionRestore,
      async () => {
        await authorizeWorkspaceOperation({
          actor: input.actor,
          routeWorkspaceId: input.routeWorkspaceId,
          capability: 'workflow:update',
          access: this.authorization,
          disclosure: 'not_found',
          allowedWorkspaceStatuses: ['active'],
          ...(input.authorizedWorkspace === undefined
            ? {}
            : { authorizedWorkspace: input.authorizedWorkspace }),
        });
        workflowVersionRestoreRequestSchema.parse(input.request);
        const restored = await this.persistence.restoreWorkflowVersion({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          versionId: input.versionId,
          actorId: input.actor.actorId,
          representationTag: input.representationTag,
          requestId: input.actor.requestId,
          ...(input.actor.traceId === undefined
            ? {}
            : { traceId: input.actor.traceId }),
        });
        return serializeWorkflowDraft(restored);
      },
    );
  }
}
