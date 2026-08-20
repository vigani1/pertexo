import {
  oidcCallbackInputSchema,
  type OidcLoginResult,
  type SessionCookieBoundary,
  type SessionIssueResult,
} from '../identity/index.js';
import {
  authorizeWorkspace,
  type ActorContext,
  type AuthorizedWorkspaceContext,
  type AuthorizationCapability,
  type WorkspaceStatus,
} from '../workspaces/index.js';
import {
  workspaceCreateRequestSchema,
  workspaceResponseSchema,
  type WorkspaceResponse,
} from './types.js';
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
    Readonly<{ authorizationUrl: string; expiresAt: Date }>
  >;
  completeLogin(
    input: Readonly<{ code: string; state: string }>,
  ): Promise<OidcLoginResult>;
}

export interface SessionIssuePort {
  issue(
    input: Readonly<{ userId: string }>,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult>;
}

export class OidcApplicationService {
  public constructor(
    private readonly oidc: OidcLoginPort,
    private readonly sessions: SessionIssuePort,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public start(): Promise<
    Readonly<{ authorizationUrl: string; expiresAt: Date }>
  > {
    return this.telemetry.measure(IDENTITY_WORKSPACE_OPERATION.oidcStart, () =>
      this.oidc.startLogin(),
    );
  }

  public async complete(
    input: unknown,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult & Readonly<{ userId: string }>> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.oidcCallback,
      async () => {
        const callback = oidcCallbackInputSchema.parse(input);
        const result = await this.oidc.completeLogin(callback);
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
  name: string;
  slug: string;
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
        const request = workspaceCreateRequestSchema.parse({
          name: input.name,
          slug: input.slug,
        });
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
  idempotencyKey: string;
  routeWorkspaceId: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export type RequestDeletionInput = WorkspaceLifecycleInput &
  Readonly<{ purgeAfter?: Date; reason: string }>;

export class WorkspaceLifecycleUseCase {
  public constructor(
    private readonly persistence: IdentityWorkspacePersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public async requestDeletion(
    input: RequestDeletionInput,
  ): Promise<WorkspaceResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceRequestDeletion,
      async () => {
        await this.authorize(
          input,
          'workspace:manage',
          LIFECYCLE_VISIBLE_STATUSES,
        );
        const result = await this.persistence.requestWorkspaceDeletion(
          input.routeWorkspaceId,
          input.actor.actorId,
          input.purgeAfter,
          input.reason,
          auditOptions(input),
        );
        return workspaceResponseSchema.parse(
          toWorkspaceResponse(result.workspace),
        );
      },
    );
  }

  public async restore(
    input: WorkspaceLifecycleInput,
  ): Promise<WorkspaceResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceRestore,
      async () => {
        await this.authorize(
          input,
          'workspace:manage',
          LIFECYCLE_VISIBLE_STATUSES,
        );
        const result = await this.persistence.restoreWorkspace(
          input.routeWorkspaceId,
          input.actor.actorId,
          auditOptions(input),
        );
        return workspaceResponseSchema.parse(
          toWorkspaceResponse(result.workspace),
        );
      },
    );
  }

  private authorize(
    input: WorkspaceLifecycleInput,
    capability: AuthorizationCapability,
    allowedWorkspaceStatuses: readonly WorkspaceStatus[],
  ): Promise<AuthorizedWorkspaceContext> {
    return authorizeWorkspace({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'forbidden',
      allowedWorkspaceStatuses,
    });
  }
}

function auditOptions(input: WorkspaceLifecycleInput): Readonly<{
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}> {
  return {
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId ?? input.actor.requestId,
    ...(input.traceId === undefined && input.actor.traceId === undefined
      ? {}
      : { traceId: input.traceId ?? input.actor.traceId }),
    metadata: input.metadata ?? {},
  };
}

function toWorkspaceResponse(
  workspace: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
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
