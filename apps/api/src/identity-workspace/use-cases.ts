import {
  oidcCallbackInputSchema,
  type OidcLoginResult,
  type SessionCookieBoundary,
  type SessionIssueResult,
} from '../identity/index.js';
import {
  authorizeWorkspaceOperation,
  type ActorContext,
  type AuthorizedWorkspaceContext,
  type AuthorizationCapability,
  AuthorizationError,
  type WorkspaceStatus,
} from '../workspaces/index.js';
import {
  workspaceCreateRequestSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceResponseSchema,
  userProfileResponseSchema,
  workspaceMembersResponseSchema,
  type UserProfileResponse,
  type WorkspaceMembersResponse,
  type WorkspaceLifecycleOperationResponse,
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
} from './ports.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';

const LIFECYCLE_VISIBLE_STATUSES = [
  'active',
  'suspended',
  'pending_deletion',
] as const satisfies readonly WorkspaceStatus[];

export interface OidcLoginPort {
  startLogin(): Promise<
    Readonly<{
      authorizationUrl: string;
      expiresAt: Date;
      browserBindingMaxAgeSeconds: number;
      browserBinding: string;
    }>
  >;
  completeLogin(
    input: Readonly<{ code: string; state: string }>,
    browserBinding: string | undefined,
  ): Promise<OidcLoginResult>;
}

export interface SessionIssuePort {
  issue(
    input: Readonly<{ userId: string }>,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult>;
}

export class GetCurrentUserUseCase {
  public constructor(
    private readonly persistence: IdentityWorkspacePersistence,
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
        return userProfileResponseSchema.parse({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
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
    private readonly persistence: IdentityWorkspacePersistence,
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

export class OidcApplicationService {
  public constructor(
    private readonly oidc: OidcLoginPort,
    private readonly sessions: SessionIssuePort,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public start(): Promise<
    Readonly<{
      authorizationUrl: string;
      expiresAt: Date;
      browserBindingMaxAgeSeconds: number;
      browserBinding: string;
    }>
  > {
    return this.telemetry.measure(IDENTITY_WORKSPACE_OPERATION.oidcStart, () =>
      this.oidc.startLogin(),
    );
  }

  public async complete(
    input: unknown,
    browserBinding: string | undefined,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult & Readonly<{ userId: string }>> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.oidcCallback,
      async () => {
        const callback = oidcCallbackInputSchema.parse(input);
        const result = await this.oidc.completeLogin(callback, browserBinding);
        const session = await this.sessions.issue(
          { userId: result.internalIdentity.userId },
          cookieBoundary,
        );
        return Object.freeze({
          ...session,
          userId: result.internalIdentity.userId,
        });
      },
    );
  }
}

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
    private readonly persistence: IdentityWorkspacePersistence,
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

export type ReadWorkspaceLifecycleOperationInput = Readonly<{
  actor: ActorContext;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  routeWorkspaceId: string;
  operationId: string;
}>;

export class WorkspaceLifecycleUseCase {
  public constructor(
    private readonly persistence: IdentityWorkspacePersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async requestDeletion(
    input: RequestDeletionInput,
  ): Promise<WorkspaceLifecycleOperationResponse> {
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
        return toWorkspaceLifecycleOperationResponse(operation);
      },
    );
  }

  public async restore(
    input: WorkspaceLifecycleInput,
  ): Promise<WorkspaceLifecycleOperationResponse> {
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
        return toWorkspaceLifecycleOperationResponse(operation);
      },
    );
  }

  public async readOperation(
    input: ReadWorkspaceLifecycleOperationInput,
  ): Promise<WorkspaceLifecycleOperationResponse> {
    await this.authorize(input, 'workspace:manage', LIFECYCLE_VISIBLE_STATUSES);
    const operation = await this.persistence.readWorkspaceLifecycleOperation(
      input.routeWorkspaceId,
      input.operationId,
      input.actor.actorId,
    );
    if (operation === null) {
      throw new AuthorizationError(
        'resource.not_found',
        'Workspace lifecycle operation was not found',
      );
    }
    return toWorkspaceLifecycleOperationResponse(operation);
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

function toWorkspaceLifecycleOperationResponse(operation: {
  id: string;
  workspaceId: string;
  commandType: 'deletion_requested' | 'deletion_restored';
  status: 'pending' | 'running' | 'completed' | 'failed';
  submittedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
}): WorkspaceLifecycleOperationResponse {
  return workspaceLifecycleOperationResponseSchema.parse({
    id: operation.id,
    workspaceId: operation.workspaceId,
    commandType: operation.commandType,
    status: operation.status,
    submittedAt: operation.submittedAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
    errorCode: operation.errorCode,
    result:
      operation.status === 'completed'
        ? { workspaceId: operation.workspaceId }
        : null,
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
