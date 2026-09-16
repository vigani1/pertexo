import type { ActorContext } from '../workspaces/index.js';
import type { IdentityWorkspacePersistence } from './ports.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import {
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  type WorkspaceMemberRoleChangeResponse,
} from './types.js';

type WorkspaceMemberRolePersistence = Pick<
  IdentityWorkspacePersistence,
  'changeWorkspaceMemberRole'
>;

export class ChangeWorkspaceMemberRoleUseCase {
  public constructor(
    private readonly persistence: WorkspaceMemberRolePersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public execute(
    input: Readonly<{
      actor: ActorContext;
      routeWorkspaceId: string;
      targetUserId: string;
      request: unknown;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<WorkspaceMemberRoleChangeResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberRoleChange,
      async () => {
        const request = workspaceMemberRoleChangeRequestSchema.parse(
          input.request,
        );
        const result = await this.persistence.changeWorkspaceMemberRole({
          workspaceId: input.routeWorkspaceId,
          actorUserId: input.actor.actorId,
          targetUserId: input.targetUserId,
          role: request.role,
          expectedRoleRevision: request.expectedRoleRevision,
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
        return workspaceMemberRoleChangeResponseSchema.parse(result);
      },
    );
  }
}
