import type { IdentityWorkspacePersistence } from '../ports.js';
import {
  memberCommandFields,
  type WorkspaceMemberCommandInput,
} from './role.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from '../telemetry.js';
import type { workspaceMemberRemovalRequestSchema } from '@pertexo/contracts';
import type { z } from 'zod';
import {
  workspaceMemberRemovalResponseSchema,
  type WorkspaceMemberRemovalResponse,
} from '../workspace-transport.js';

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
    input: WorkspaceMemberCommandInput<
      z.output<typeof workspaceMemberRemovalRequestSchema>
    >,
  ): Promise<WorkspaceMemberRemovalResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberRemoval,
      async () => {
        const result = await this.persistence.removeWorkspaceMember({
          ...memberCommandFields(input),
          expectedRoleRevision: input.request.expectedRoleRevision,
        });
        return workspaceMemberRemovalResponseSchema.parse(result);
      },
    );
  }
}
