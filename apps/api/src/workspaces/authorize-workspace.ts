import {
  AUTHORIZATION_CAPABILITIES,
  MEMBERSHIP_STATUSES,
  ROLES,
  WORKSPACE_STATUSES,
  type ActorContext,
  type AuthorizedWorkspaceContext,
  type AuthorizationCapability,
  type DisclosurePolicy,
  type MembershipStatus,
  type Role,
  type WorkspaceAccess,
  type WorkspaceStatus,
} from './types.js';
import {
  createActorContext,
  isCanonicalUuid,
  isActorContext,
} from './actor-context.js';
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
}>;

export interface WorkspaceAuthorizationPort {
  findAccess(query: WorkspaceAccessQuery): Promise<WorkspaceAccess | undefined>;
}

/** DI/guard token for the narrow pre-transaction authorization port. */
const WORKSPACE_AUTHORIZATION_PORT = Symbol.for(
  'pertexo.workspaces.authorization-port',
);

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
}>;

export type AssertAuthorizedWorkspaceContextInput = Readonly<{
  context: AuthorizedWorkspaceContext;
  actor: ActorContext;
  routeWorkspaceId: string;
  capability: AuthorizationCapability;
}>;

export type AuthorizeWorkspaceOperationInput = AuthorizeWorkspaceInput &
  Readonly<{ authorizedWorkspace?: AuthorizedWorkspaceContext }>;

const issuedAuthorizationContexts = new WeakSet<object>();

function denied(
  disclosure: DisclosurePolicy,
  message: string,
): AuthorizationError {
  return new AuthorizationError(
    disclosure === 'not_found' ? 'resource.not_found' : 'auth.forbidden',
    message,
  );
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function invalid(message: string): AuthorizationError {
  return new AuthorizationError('request.invalid', message);
}

function validateAccess(access: WorkspaceAccess): boolean {
  return (
    isCanonicalUuid(access.actorId) &&
    isCanonicalUuid(access.workspaceId) &&
    isOneOf(ROLES, access.role) &&
    isOneOf(MEMBERSHIP_STATUSES, access.membershipStatus) &&
    isOneOf(WORKSPACE_STATUSES, access.workspaceStatus)
  );
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
  if (!isActorContext(input.actor)) {
    throw invalid(
      'actor context is invalid or was not created by the identity boundary',
    );
  }
  const actor = createActorContext(input.actor);
  if (!isCanonicalUuid(input.routeWorkspaceId)) {
    throw invalid('route workspace id is required');
  }
  if (!isOneOf(AUTHORIZATION_CAPABILITIES, input.capability)) {
    throw invalid('authorization capability is not recognized');
  }
  if (actor.workspaceId !== input.routeWorkspaceId) {
    throw denied(
      disclosure,
      'selected workspace does not match route workspace',
    );
  }

  const record = await findAccess(input.access, {
    actorId: actor.actorId,
    workspaceId: input.routeWorkspaceId,
  });
  if (record === undefined) {
    throw denied(disclosure, 'actor is not a member of this workspace');
  }
  if (!validateAccess(record)) {
    throw invalid('workspace access record is invalid');
  }
  if (
    record.actorId !== actor.actorId ||
    record.workspaceId !== input.routeWorkspaceId
  ) {
    throw denied(
      disclosure,
      'workspace access record does not match the request',
    );
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
  issuedAuthorizationContexts.add(context);
  return context;
}

export function assertAuthorizedWorkspaceContext(
  input: AssertAuthorizedWorkspaceContextInput,
): AuthorizedWorkspaceContext {
  if (!issuedAuthorizationContexts.has(input.context)) {
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
  return input.context;
}

export function authorizeWorkspaceOperation(
  input: AuthorizeWorkspaceOperationInput,
): Promise<AuthorizedWorkspaceContext> {
  if (input.authorizedWorkspace === undefined || input.actor === undefined) {
    return authorizeWorkspace(input);
  }
  return Promise.resolve(
    assertAuthorizedWorkspaceContext({
      context: input.authorizedWorkspace,
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: input.capability,
    }),
  );
}

const authorizeWorkspaceAccess = authorizeWorkspace;

export type { WorkspaceStatus };
