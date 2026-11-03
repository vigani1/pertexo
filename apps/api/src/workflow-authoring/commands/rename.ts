import type { workflowRenameRequestSchema } from '@pertexo/contracts';
import {
  workflowRenameResponseSchema,
  type WorkflowRenameResponse,
} from '@pertexo/contracts';
import type { z } from 'zod';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import { workflowSummary } from '../http/serializers.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from '../ports.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';

export type RenameWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    workflowId: string;
    request: z.output<typeof workflowRenameRequestSchema>;
    idempotencyKey: string;
  }>;

/**
 * ADR 041: the display name has its own revision, so a rename never races a
 * draft save or a lifecycle command. Editing authority is enough to rename.
 */
export class RenameWorkflowUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowAuthoringPersistence,
      'renameWorkflow'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: RenameWorkflowInput): Promise<WorkflowRenameResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.rename,
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
        const { name, expectedNameRevision } = input.request;
        const renamed = await this.persistence.renameWorkflow({
          name,
          expectedNameRevision,
          idempotencyKey: input.idempotencyKey,
          workflowId: input.workflowId,
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          requestId: input.actor.requestId,
          ...(input.actor.traceId === undefined
            ? {}
            : { traceId: input.actor.traceId }),
        });
        return workflowRenameResponseSchema.parse({
          workflow: workflowSummary(renamed.workflow),
          replayed: renamed.replayed,
        });
      },
    );
  }
}
