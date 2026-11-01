import type { apiTokens } from '@pertexo/database/schema';
import type { ApiTokenMetadata } from '@pertexo/contracts';

export type ApiTokenRow = typeof apiTokens.$inferSelect;
export function apiTokenStatus(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata['status'] {
  return row.revokedAt === null
    ? unrevokedTokenStatus(row, membershipRevision, now)
    : 'revoked';
}

function unrevokedTokenStatus(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
) {
  if (row.membershipRevision !== membershipRevision) {
    return 'membership_changed';
  }
  if (row.expiresAt <= now) {
    return 'expired';
  }
  return 'active';
}

export function apiTokenMetadata(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata {
  const fields = {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    scopes: [...row.scopes],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
  return row.revokedAt === null
    ? {
        ...fields,
        status: unrevokedTokenStatus(row, membershipRevision, now),
        revokedAt: null,
      }
    : {
        ...fields,
        status: 'revoked',
        revokedAt: row.revokedAt.toISOString(),
      };
}
