import type { IdentityWorkspacePersistence } from './ports.js';
import {
  memberCommandFields,
  type WorkspaceMemberCommandInput,
} from './member-role-use-case.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import {
  workspaceMemberRemovalRequestSchema,
  workspaceMemberRemovalResponseSchema,
  type WorkspaceMemberRemovalResponse,
} from './types.js';

type WorkspaceMemberRemovalPersistence = Required<
  Pick<IdentityWorkspacePersistence, 'removeWorkspaceMember'>
>;

/** ADR 042: removes an existing member at the revision the actor saw. */
export class RemoveWorkspaceMemberUseCase {
  public constructor(
    private readonly persistence: WorkspaceMemberRemovalPersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public execute(
    input: WorkspaceMemberCommandInput,
  ): Promise<WorkspaceMemberRemovalResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberRemoval,
      async () => {
        const request = workspaceMemberRemovalRequestSchema.parse(
          input.request,
        );
        const result = await this.persistence.removeWorkspaceMember({
          ...memberCommandFields(input),
          expectedRoleRevision: request.expectedRoleRevision,
        });
        return workspaceMemberRemovalResponseSchema.parse(result);
      },
    );
  }
}
