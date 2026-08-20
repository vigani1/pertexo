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
  ) {}

  public start(): Promise<
    Readonly<{ authorizationUrl: string; expiresAt: Date }>
  > {
    return this.oidc.startLogin();
  }

  public async complete(
    input: unknown,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult & Readonly<{ userId: string }>> {
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
  }
}

export type CreateWorkspaceInput = Readonly<{
  actorId: string;
  name: string;
  slug: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export class CreateWorkspaceUseCase {
  public constructor(
    private readonly persistence: IdentityWorkspacePersistence,
  ) {}

  public async execute(
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceResponse> {
    const request = workspaceCreateRequestSchema.parse({
      name: input.name,
      slug: input.slug,
    });
    const workspace = await this.persistence.createWorkspaceWithOwner({
      ownerUserId: input.actorId,
      name: request.name,
      slug: request.slug,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: input.metadata ?? {},
    });
    return workspaceResponseSchema.parse(toWorkspaceResponse(workspace));
  }
}

export type WorkspaceLifecycleInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export type RequestDeletionInput = WorkspaceLifecycleInput &
  Readonly<{ purgeAfter: Date; reason: string }>;

export class WorkspaceLifecycleUseCase {
  public constructor(
    private readonly persistence: IdentityWorkspacePersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async requestDeletion(
    input: RequestDeletionInput,
  ): Promise<WorkspaceResponse> {
    await this.authorize(input, 'workspace:manage');
    const result = await this.persistence.requestWorkspaceDeletion(
      input.routeWorkspaceId,
      input.actor.actorId,
      input.purgeAfter,
      input.reason,
      auditOptions(input),
    );
    return workspaceResponseSchema.parse(toWorkspaceResponse(result.workspace));
  }

  public async restore(
    input: WorkspaceLifecycleInput,
  ): Promise<WorkspaceResponse> {
    await this.authorize(input, 'workspace:manage');
    const result = await this.persistence.restoreWorkspace(
      input.routeWorkspaceId,
      input.actor.actorId,
      auditOptions(input),
    );
    return workspaceResponseSchema.parse(toWorkspaceResponse(result.workspace));
  }

  private authorize(
    input: WorkspaceLifecycleInput,
    capability: AuthorizationCapability,
  ): Promise<AuthorizedWorkspaceContext> {
    return authorizeWorkspace({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'forbidden',
    });
  }
}

function auditOptions(input: WorkspaceLifecycleInput): Readonly<{
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}> {
  return {
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
