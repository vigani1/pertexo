import type { apiTokens } from '../../schema/identity/api-tokens.js';
import type { ApiTokenMetadata } from '@pertexo/contracts';

export type ApiTokenRow = typeof apiTokens.$inferSelect;
export function apiTokenStatus(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata['status'] {
  if (row.revokedAt !== null) {
    return 'revoked';
  }
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
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    scopes: [...row.scopes],
    status: apiTokenStatus(row, membershipRevision, now),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
