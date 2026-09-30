import type { AccountSecuritySessionsResponse } from '@pertexo/contracts/schemas/identity-workspace';

type Session = AccountSecuritySessionsResponse['items'][number];

/** This device first, then the others from the most recently active. */
export function orderSessions(items: readonly Session[]): readonly Session[] {
  return [...items].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
