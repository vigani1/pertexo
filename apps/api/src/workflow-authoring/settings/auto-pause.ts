import {
  workflowAutoPauseSettingsSchema,
  workflowAutoPauseSettingsRequestSchema,
  workflowAutoPauseCommandResponseSchema,
  workflowResumeRequestSchema,
  workspaceAutoPauseSettingsSchema,
  workspaceAutoPauseSettingsRequestSchema,
  workspaceAutoPauseCommandResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowAutoPauseDatabase } from '@pertexo/database/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';

type WorkflowReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string }>;
type CommandInput = WorkflowApplicationInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;

/** Operational controls never modify a draft, a published version or trigger enablement. */
export class WorkflowAutoPauseUseCase {
  public constructor(
    private readonly persistence: WorkflowAutoPauseDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async readWorkflow(input: WorkflowReadInput) {
    await this.authorize(input, 'workflow:read');
    return workflowAutoPauseSettingsSchema.parse(
      await this.persistence.readWorkflowSettings({
        workspaceId: input.routeWorkspaceId,
        workflowId: input.workflowId,
        actorId: input.actor.actorId,
      }),
    );
  }

  public async updateWorkflow(
    input: CommandInput & Readonly<{ workflowId: string }>,
  ) {
    await this.authorize(input, 'workflow:update');
    const request = workflowAutoPauseSettingsRequestSchema.parse(input.request);
    return workflowAutoPauseCommandResponseSchema.parse(
      await this.persistence.updateWorkflowSettings({
        ...this.commandContext(input),
        ...request,
        workflowId: input.workflowId,
      }),
    );
  }

  public async resume(input: CommandInput & Readonly<{ workflowId: string }>) {
    await this.authorize(input, 'workflow:publish');
    const request = workflowResumeRequestSchema.parse(input.request);
    return workflowAutoPauseCommandResponseSchema.parse(
      await this.persistence.resumeWorkflow({
        ...this.commandContext(input),
        ...request,
        workflowId: input.workflowId,
      }),
    );
  }

  public async readWorkspace(input: WorkflowApplicationInput) {
    await this.authorize(input, 'workspace:read');
    return workspaceAutoPauseSettingsSchema.parse(
      await this.persistence.readWorkspaceSettings({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
      }),
    );
  }

  public async updateWorkspace(input: CommandInput) {
    await this.authorize(input, 'workspace:manage');
    const request = workspaceAutoPauseSettingsRequestSchema.parse(
      input.request,
    );
    return workspaceAutoPauseCommandResponseSchema.parse(
      await this.persistence.updateWorkspaceSettings({
        ...this.commandContext(input),
        ...request,
      }),
    );
  }

  private authorize(
    input: WorkflowApplicationInput,
    capability:
      | 'workspace:read'
      | 'workspace:manage'
      | 'workflow:read'
      | 'workflow:update'
      | 'workflow:publish',
  ) {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }

  private commandContext(input: CommandInput) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      idempotencyKey: input.idempotencyKey,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
    };
  }
}
