import type { ActorContext } from '../workspaces/index.js';
import type { IdentityWorkspacePersistence } from './ports.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import {
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  type WorkspaceRenameResponse,
} from './types.js';

type RenamePersistence = Required<
  Pick<IdentityWorkspacePersistence, 'renameWorkspace'>
>;

export class RenameWorkspaceUseCase {
  public constructor(
    private readonly persistence: RenamePersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public execute(
    input: Readonly<{
      actor: ActorContext;
      routeWorkspaceId: string;
      request: unknown;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<WorkspaceRenameResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceRename,
      async () => {
        const request = workspaceRenameRequestSchema.parse(input.request);
        const result = await this.persistence.renameWorkspace({
          workspaceId: input.routeWorkspaceId,
          actorUserId: input.actor.actorId,
          name: request.name,
          expectedRevision: request.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
        return workspaceRenameResponseSchema.parse({
          workspace: {
            id: result.workspace.id,
            name: result.workspace.name,
            slug: result.workspace.slug,
            status: result.workspace.status,
            revision: result.workspace.revision,
            createdAt: result.workspace.createdAt.toISOString(),
            updatedAt: result.workspace.updatedAt.toISOString(),
          },
          changed: result.changed,
          replayed: result.replayed,
        });
      },
    );
  }
}
