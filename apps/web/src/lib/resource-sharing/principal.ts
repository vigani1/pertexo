import type { SharingPrincipals } from '@pertexo/contracts';

/** A member is identified by their user, a directory group by its group. */
export function principalIdentifier(
  principal: SharingPrincipals['items'][number],
): string {
  return principal.kind === 'member' ? principal.userId : principal.groupId;
}
