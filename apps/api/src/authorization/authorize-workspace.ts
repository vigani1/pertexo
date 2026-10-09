import type {
  ActorContext,
  AuthorizedWorkspaceContext,
  AuthorizationCapability,
  DisclosurePolicy,
  WorkspaceAccess,
  WorkspaceStatus,
} from './types.js';
import { hasCapability } from './policy.js';

export type AuthorizationErrorCode =
  | 'auth.unauthenticated'
  | 'auth.forbidden'
  | 'resource.not_found'
  | 'request.invalid';

export class AuthorizationError extends Error {
  public readonly code: AuthorizationErrorCode;

  public constructor(code: AuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export type WorkspaceAccessQuery = Readonly<{
  actorId: string;
  workspaceId: string;
  signal?: AbortSignal;
}>;

export interface WorkspaceAuthorizationPort {
  findAccess(query: WorkspaceAccessQuery): Promise<WorkspaceAccess | undefined>;
}

type WorkspaceAccessLookup = (
  query: WorkspaceAccessQuery,
) => Promise<WorkspaceAccess | undefined>;

export type WorkspaceAuthorizationSource =
  WorkspaceAuthorizationPort | WorkspaceAccessLookup;

export type AuthorizeWorkspaceInput = Readonly<{
  actor: ActorContext | undefined;
  routeWorkspaceId: string;
  capability: AuthorizationCapability;
  access: WorkspaceAuthorizationSource;
  disclosure?: DisclosurePolicy;
  allowedWorkspaceStatuses?: readonly WorkspaceStatus[];
  signal?: AbortSignal;
}>;

export type AssertAuthorizedWorkspaceContextInput = Readonly<{
  context: AuthorizedWorkspaceContext;
  actor: ActorContext;
  routeWorkspaceId: string;
  capability: AuthorizationCapability;
  disclosure?: DisclosurePolicy;
  allowedWorkspaceStatuses?: readonly WorkspaceStatus[];
  signal?: AbortSignal;
}>;

export type AuthorizeWorkspaceOperationInput = AuthorizeWorkspaceInput &
  Readonly<{ authorizedWorkspace?: AuthorizedWorkspaceContext }>;

const issuedAuthorizationContexts = new WeakMap<
  object,
  Readonly<{ workspaceStatus: WorkspaceStatus }>
>();

function denied(
  disclosure: DisclosurePolicy,
  message: string,
): AuthorizationError {
  return new AuthorizationError(
    disclosure === 'not_found' ? 'resource.not_found' : 'auth.forbidden',
    message,
  );
}

function invalid(message: string): AuthorizationError {
  return new AuthorizationError('request.invalid', message);
}

async function findAccess(
  source: WorkspaceAuthorizationSource,
  query: WorkspaceAccessQuery,
): Promise<WorkspaceAccess | undefined> {
  return typeof source === 'function'
    ? source(query)
    : source.findAccess(query);
}

export async function authorizeWorkspace(
  input: AuthorizeWorkspaceInput,
): Promise<AuthorizedWorkspaceContext> {
  const disclosure = input.disclosure ?? 'forbidden';
  if (input.actor === undefined) {
    throw new AuthorizationError(
      'auth.unauthenticated',
      'an authenticated actor is required',
    );
  }
  // The actor and route ids were parsed where they entered.
  const { actor } = input;
  if (actor.workspaceId !== input.routeWorkspaceId) {
    throw denied(
      disclosure,
      'selected workspace does not match route workspace',
    );
  }

  input.signal?.throwIfAborted();
  const record = await findAccess(input.access, {
    actorId: actor.actorId,
    workspaceId: input.routeWorkspaceId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  input.signal?.throwIfAborted();
  if (record === undefined) {
    throw denied(disclosure, 'actor is not a member of this workspace');
  }
  if (record.membershipStatus !== 'active') {
    throw denied(disclosure, 'workspace membership is not active');
  }
  const allowedWorkspaceStatuses = input.allowedWorkspaceStatuses ?? ['active'];
  if (!allowedWorkspaceStatuses.includes(record.workspaceStatus)) {
    throw denied(disclosure, 'workspace lifecycle does not allow this action');
  }
  if (!hasCapability(record.role, input.capability)) {
    throw denied(disclosure, 'actor lacks the requested workspace capability');
  }

  const context: AuthorizedWorkspaceContext = Object.freeze({
    actor,
    workspaceId: input.routeWorkspaceId,
    role: record.role,
    capability: input.capability,
  });
  issuedAuthorizationContexts.set(
    context,
    Object.freeze({ workspaceStatus: record.workspaceStatus }),
  );
  return context;
}

export function assertAuthorizedWorkspaceContext(
  input: AssertAuthorizedWorkspaceContextInput,
): AuthorizedWorkspaceContext {
  const proof = issuedAuthorizationContexts.get(input.context);
  if (proof === undefined) {
    throw invalid(
      'authorization context was not established by the guard seam',
    );
  }
  const authorizedActor = input.context.actor;
  if (
    input.context.workspaceId !== input.routeWorkspaceId ||
    input.context.capability !== input.capability ||
    authorizedActor.actorId !== input.actor.actorId ||
    authorizedActor.workspaceId !== input.actor.workspaceId ||
    authorizedActor.sessionId !== input.actor.sessionId ||
    authorizedActor.requestId !== input.actor.requestId ||
    authorizedActor.traceId !== input.actor.traceId
  ) {
    throw denied(
      'forbidden',
      'authorization context does not match the operation',
    );
  }
  input.signal?.throwIfAborted();
  const allowedWorkspaceStatuses = input.allowedWorkspaceStatuses ?? ['active'];
  if (!allowedWorkspaceStatuses.includes(proof.workspaceStatus)) {
    throw denied(
      input.disclosure ?? 'forbidden',
      'workspace lifecycle does not allow this action',
    );
  }
  return input.context;
}

export async function authorizeWorkspaceOperation(
  input: AuthorizeWorkspaceOperationInput,
): Promise<AuthorizedWorkspaceContext> {
  if (input.authorizedWorkspace === undefined || input.actor === undefined) {
    return authorizeWorkspace(input);
  }
  return assertAuthorizedWorkspaceContext({
    context: input.authorizedWorkspace,
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: input.capability,
    ...(input.disclosure === undefined ? {} : { disclosure: input.disclosure }),
    ...(input.allowedWorkspaceStatuses === undefined
      ? {}
      : { allowedWorkspaceStatuses: input.allowedWorkspaceStatuses }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export type { WorkspaceStatus };
