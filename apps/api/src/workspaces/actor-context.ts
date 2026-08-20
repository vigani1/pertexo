import type { ActorContext, WorkspaceId } from './types.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
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

export function createActorContext(
  input: CreateActorContextInput,
): ActorContext {
  if (input.kind !== undefined && input.kind !== 'user') {
    throw new TypeError('actor kind must be user');
  }

  const context: ActorContext = {
    actorId: requireIdentifier(input.actorId, 'actorId'),
    kind: 'user',
    workspaceId: requireIdentifier(input.workspaceId, 'workspaceId'),
    sessionId: requireIdentifier(input.sessionId, 'sessionId'),
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
    isSafeIdentifier(candidate.actorId) &&
    isSafeIdentifier(candidate.workspaceId) &&
    isSafeIdentifier(candidate.sessionId) &&
    isSafeIdentifier(candidate.requestId) &&
    (candidate.traceId === undefined || isSafeIdentifier(candidate.traceId))
  );
}
