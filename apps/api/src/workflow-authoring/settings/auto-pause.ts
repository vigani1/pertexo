import { commandCredential } from '../../authorization/credentials.js';
import type { z } from 'zod';
import type {
  workflowAutoPauseSettingsRequestSchema,
  workflowResumeRequestSchema,
  workspaceAutoPauseSettingsRequestSchema,
} from '@pertexo/contracts';
import {
  workflowAutoPauseSettingsSchema,
  workflowAutoPauseCommandResponseSchema,
  workspaceAutoPauseSettingsSchema,
  workspaceAutoPauseCommandResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowAutoPauseStore } from '@pertexo/core/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
  BROWSABLE_WORKSPACE_STATUSES,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';

type WorkflowReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string }>;
type CommandInput<Request> = WorkflowApplicationInput &
  Readonly<{ request: Request; idempotencyKey: string }>;

/** Operational controls never modify a draft, a published version or trigger enablement. */
export class WorkflowAutoPauseUseCase {
  public constructor(
    private readonly persistence: WorkflowAutoPauseStore,
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
    input: CommandInput<
      z.output<typeof workflowAutoPauseSettingsRequestSchema>
    > &
      Readonly<{ workflowId: string }>,
  ) {
    await this.authorize(input, 'workflow:update');
    const { request } = input;
    return workflowAutoPauseCommandResponseSchema.parse(
      await this.persistence.updateWorkflowSettings({
        ...this.commandContext(input),
        ...request,
        workflowId: input.workflowId,
      }),
    );
  }

  public async resume(
    input: CommandInput<z.output<typeof workflowResumeRequestSchema>> &
      Readonly<{ workflowId: string }>,
  ) {
    await this.authorize(input, 'workflow:publish');
    const { request } = input;
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

  public async updateWorkspace(
    input: CommandInput<
      z.output<typeof workspaceAutoPauseSettingsRequestSchema>
    >,
  ) {
    await this.authorize(input, 'workspace:manage');
    const { request } = input;
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
      allowedWorkspaceStatuses:
        capability === 'workflow:read' || capability === 'workspace:read'
          ? BROWSABLE_WORKSPACE_STATUSES
          : ['active'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }

  private commandContext(input: CommandInput<unknown>) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      ...commandCredential(input.actor),
      idempotencyKey: input.idempotencyKey,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
    };
  }
}
