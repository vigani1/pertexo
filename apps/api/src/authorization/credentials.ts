import { credentialCommandScope } from '@pertexo/database/platform';
import type { ActorContext, AuthorizationCapability } from './types.js';

export function credentialAllowsCapability(
  actor: ActorContext,
  capability: AuthorizationCapability,
): boolean {
  return (
    actor.kind === 'user' || actor.scopes.some((scope) => scope === capability)
  );
}
export function sameActorCredential(
  left: ActorContext,
  right: ActorContext,
): boolean {
  if (left.kind === 'user')
    return right.kind === 'user' && left.sessionId === right.sessionId;
  return (
    right.kind === 'api_key' &&
    left.tokenId === right.tokenId &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}
export function commandIdempotencyScope(
  actor: ActorContext,
  scope: string,
): string {
  return credentialCommandScope(
    scope,
    actor.kind === 'api_key' ? actor.tokenId : undefined,
  );
}
export function commandCredential(
  actor: ActorContext,
): Readonly<{ commandCredentialId?: string }> {
  return actor.kind === 'user' ? {} : { commandCredentialId: actor.tokenId };
}
