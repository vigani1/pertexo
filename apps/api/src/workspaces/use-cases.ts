import {
  authorizeWorkspaceOperation,
  capabilitiesForRole,
  type ActorContext,
  type AuthorizedWorkspaceContext,
  type AuthorizationCapability,
  AuthorizationError,
  type WorkspaceStatus,
} from '../authorization/index.js';
import {
  accessibleWorkspacesResponseSchema,
  workspaceCreateRequestSchema,
  workspaceLifecycleChangeResponseSchema,
  workspaceResponseSchema,
  workspaceMembersResponseSchema,
  type AccessibleWorkspacesResponse,
  type UserProfileResponse,
  type WorkspaceMembersResponse,
  type WorkspaceLifecycleChangeResponse,
  type WorkspaceResponse,
} from './types.js';
import {
  decodeWorkspaceMemberCursor,
  InvalidWorkspaceMemberCursorError,
  encodeWorkspaceMemberCursor,
} from './cursor.js';
import type {
  IdentityWorkspacePersistence,
  WorkspaceAuthorizationSource,
  WorkspaceLifecycleOperationRecord,
} from './ports.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import { projectUserProfile } from './commands/user-profile.js';

const LIFECYCLE_VISIBLE_STATUSES = [
  'active',
  'suspended',
  'pending_deletion',
] as const satisfies readonly WorkspaceStatus[];

type CurrentUserPersistence = Pick<
  IdentityWorkspacePersistence,
  'findUserById'
>;
type AccessibleWorkspacesPersistence = Pick<
  IdentityWorkspacePersistence,
  'listAccessibleWorkspaces'
>;
type WorkspaceMembersPersistence = Pick<
  IdentityWorkspacePersistence,
  'listWorkspaceMembers'
>;
type WorkspaceCreationPersistence = Pick<
  IdentityWorkspacePersistence,
  'createWorkspaceWithOwner'
>;
type WorkspaceLifecyclePersistence = Pick<
  IdentityWorkspacePersistence,
  'requestWorkspaceLifecycleOperation'
>;

export class GetCurrentUserUseCase {
  public constructor(
    private readonly persistence: CurrentUserPersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async execute(userId: string): Promise<UserProfileResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.userProfileRead,
      async () => {
        const user = await this.persistence.findUserById(userId);
        if (user?.status !== 'active') {
          throw new AuthorizationError(
            'auth.unauthenticated',
            'The current user is no longer available',
          );
        }
        return projectUserProfile(user);
      },
    );
  }
}

export class ListAccessibleWorkspacesUseCase {
  public constructor(
    private readonly persistence: AccessibleWorkspacesPersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public execute(
    userId: string,
    input: Readonly<{ limit?: number; after?: string }> = {},
  ): Promise<AccessibleWorkspacesResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.accessibleWorkspacesList,
      async () => {
        const page = await this.persistence.listAccessibleWorkspaces(
          userId,
          input,
        );
        return accessibleWorkspacesResponseSchema.parse({
          items: page.items.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            status: workspace.status,
            revision: workspace.revision,
            role: workspace.role,
            capabilities: capabilitiesForRole(workspace.role),
            createdAt: workspace.createdAt.toISOString(),
            updatedAt: workspace.updatedAt.toISOString(),
          })),
          nextCursor: page.nextCursor ?? null,
        });
      },
    );
  }
}

export type ListWorkspaceMembersInput = Readonly<{
  actor: ActorContext;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  routeWorkspaceId: string;
  limit?: number;
  after?: string;
}>;

export class ListWorkspaceMembersUseCase {
  public constructor(
    private readonly persistence: WorkspaceMembersPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async execute(
    input: ListWorkspaceMembersInput,
  ): Promise<WorkspaceMembersResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceMembersList,
      async () => {
        await authorizeWorkspaceOperation({
          actor: input.actor,
          routeWorkspaceId: input.routeWorkspaceId,
          capability: 'member:read',
          access: this.authorization,
          disclosure: 'forbidden',
          ...(input.authorizedWorkspace === undefined
            ? {}
            : { authorizedWorkspace: input.authorizedWorkspace }),
        });
        let after: Readonly<{ createdAt: string; userId: string }> | undefined;
        if (input.after !== undefined) {
          try {
            after = decodeWorkspaceMemberCursor(input.after);
          } catch (error: unknown) {
            if (error instanceof InvalidWorkspaceMemberCursorError)
              throw new AuthorizationError(
                'request.invalid',
                'workspace member cursor is invalid',
              );
            throw error;
          }
        }
        const page = await this.persistence.listWorkspaceMembers(
          input.routeWorkspaceId,
          input.actor.actorId,
          {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(after === undefined ? {} : { after }),
          },
        );
        return workspaceMembersResponseSchema.parse({
          items: page.items.map((member) => ({
            userId: member.userId,
            email: member.email,
            displayName: member.displayName,
            role: member.role,
            roleRevision: member.roleRevision,
            membershipStatus: member.membershipStatus,
            createdAt: member.createdAt.toISOString(),
            updatedAt: member.updatedAt.toISOString(),
          })),
          nextCursor:
            page.nextCursor === undefined
              ? null
              : encodeWorkspaceMemberCursor(page.nextCursor),
        });
      },
    );
  }
}

export { ChangeWorkspaceMemberRoleUseCase } from './members/role.js';

export type CreateWorkspaceInput = Readonly<{
  actorId: string;
  idempotencyKey: string;
  request: unknown;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export class CreateWorkspaceUseCase {
  public constructor(
    private readonly persistence: WorkspaceCreationPersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async execute(
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceCreate,
      async () => {
        const request = workspaceCreateRequestSchema.parse(input.request);
        const workspace = await this.persistence.createWorkspaceWithOwner({
          ownerUserId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          name: request.name,
          slug: request.slug,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          metadata: input.metadata ?? {},
        });
        return workspaceResponseSchema.parse(toWorkspaceResponse(workspace));
      },
    );
  }
}

export type WorkspaceLifecycleInput = Readonly<{
  actor: ActorContext;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  idempotencyKey: string;
  routeWorkspaceId: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export type RequestDeletionInput = WorkspaceLifecycleInput &
  Readonly<{ reason: string }>;

export class WorkspaceLifecycleUseCase {
  public constructor(
    private readonly persistence: WorkspaceLifecyclePersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async requestDeletion(
    input: RequestDeletionInput,
  ): Promise<WorkspaceLifecycleChangeResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceRequestDeletion,
      async () => {
        await this.authorize(
          input,
          'workspace:manage',
          LIFECYCLE_VISIBLE_STATUSES,
        );
        const operation =
          await this.persistence.requestWorkspaceLifecycleOperation({
            workspaceId: input.routeWorkspaceId,
            actorUserId: input.actor.actorId,
            commandType: 'deletion_requested',
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          });
        return toWorkspaceLifecycleChangeResponse(operation);
      },
    );
  }

  public async restore(
    input: WorkspaceLifecycleInput,
  ): Promise<WorkspaceLifecycleChangeResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceRestore,
      async () => {
        await this.authorize(
          input,
          'workspace:manage',
          LIFECYCLE_VISIBLE_STATUSES,
        );
        const operation =
          await this.persistence.requestWorkspaceLifecycleOperation({
            workspaceId: input.routeWorkspaceId,
            actorUserId: input.actor.actorId,
            commandType: 'deletion_restored',
            reason: 'Workspace deletion restored',
            idempotencyKey: input.idempotencyKey,
          });
        return toWorkspaceLifecycleChangeResponse(operation);
      },
    );
  }

  private authorize(
    input: Readonly<{
      actor: ActorContext;
      authorizedWorkspace?: AuthorizedWorkspaceContext;
      routeWorkspaceId: string;
    }>,
    capability: AuthorizationCapability,
    allowedWorkspaceStatuses: readonly WorkspaceStatus[],
  ): Promise<AuthorizedWorkspaceContext> {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'forbidden',
      allowedWorkspaceStatuses,
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}

/** A request is applied when it is submitted; a replay returns the same change. */
function toWorkspaceLifecycleChangeResponse(
  operation: WorkspaceLifecycleOperationRecord,
): WorkspaceLifecycleChangeResponse {
  return workspaceLifecycleChangeResponseSchema.parse({
    workspaceId: operation.workspaceId,
    change: operation.commandType,
    occurredAt: operation.submittedAt.toISOString(),
  });
}

function toWorkspaceResponse(
  workspace: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
    createdAt: Date;
    updatedAt: Date;
  }>,
): WorkspaceResponse {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}
