import { workflowVersionRestoreResponseSchema } from '@pertexo/contracts';
import type { workflowVersionRestoreRequestSchema } from '@pertexo/contracts';
import type { z } from 'zod';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import { serializeWorkflowDraft } from '../http/serializers.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from '../ports.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';

export type RestoreWorkflowVersionInput = WorkflowApplicationInput &
  Readonly<{
    workflowId: string;
    versionId: string;
    representationTag: string;
    idempotencyKey?: string;
    request: z.output<typeof workflowVersionRestoreRequestSchema>;
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

  public execute(input: RestoreWorkflowVersionInput): Promise<
    Readonly<{
      body: z.output<typeof workflowVersionRestoreResponseSchema>;
      representationTag: string;
    }>
  > {
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
        const restored = await this.persistence.restoreWorkflowVersion({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          versionId: input.versionId,
          actorId: input.actor.actorId,
          representationTag: input.representationTag,
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
          requestId: input.actor.requestId,
          ...(input.actor.traceId === undefined
            ? {}
            : { traceId: input.actor.traceId }),
        });
        const draft = await serializeWorkflowDraft(restored);
        return {
          ...draft,
          body: workflowVersionRestoreResponseSchema.parse({
            ...draft.body,
            recoveryCopyId: restored.recoveryCopyId,
          }),
        };
      },
    );
  }
}
