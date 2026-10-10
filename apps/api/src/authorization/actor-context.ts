import { UUID_PATTERN } from '@pertexo/workflow-model';
import type { ActorContext, WorkspaceId } from './types.js';

const uuidPattern = new RegExp(UUID_PATTERN.source, 'iu');

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export type CreateActorContextInput = Readonly<{
  actorId: string;
  workspaceId: WorkspaceId;
  sessionId: string;
  requestId: string;
  traceId?: string;
}>;

/**
 * The request's actor. Its ids come from the verified session, the parsed
 * route and the request-id and traceparent parsers.
 */
export function createActorContext(
  input: CreateActorContextInput,
): ActorContext {
  return Object.freeze({
    actorId: input.actorId,
    kind: 'user',
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}
