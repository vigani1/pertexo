import type { ActorContext, WorkspaceId } from './types.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const boundedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && boundedIdentifierPattern.test(value);
}

export type CreateActorContextInput = Readonly<{
  actorId: string;
  kind?: string;
  workspaceId: WorkspaceId;
  sessionId: string;
  requestId: string;
  traceId?: string;
}>;

function requireIdentifier(value: string, name: string): string {
  if (!isSafeIdentifier(value)) {
    throw new TypeError(`${name} must be a bounded safe identifier`);
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!isCanonicalUuid(value)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return value;
}

export function createActorContext(
  input: CreateActorContextInput,
): ActorContext {
  if (input.kind !== undefined && input.kind !== 'user') {
    throw new TypeError('actor kind must be user');
  }

  const context: ActorContext = {
    actorId: requireUuid(input.actorId, 'actorId'),
    kind: 'user',
    workspaceId: requireUuid(input.workspaceId, 'workspaceId'),
    sessionId: requireUuid(input.sessionId, 'sessionId'),
    requestId: requireIdentifier(input.requestId, 'requestId'),
    ...(input.traceId === undefined
      ? {}
      : { traceId: requireIdentifier(input.traceId, 'traceId') }),
  };

  return Object.freeze(context);
}

export function isActorContext(value: unknown): value is ActorContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ActorContext>;
  return (
    candidate.kind === 'user' &&
    isCanonicalUuid(candidate.actorId) &&
    isCanonicalUuid(candidate.workspaceId) &&
    isCanonicalUuid(candidate.sessionId) &&
    isSafeIdentifier(candidate.requestId) &&
    (candidate.traceId === undefined || isSafeIdentifier(candidate.traceId))
  );
}
