import type { ApiTokenMetadata } from '@pertexo/contracts';
import {
  unrevokedTokenStatus,
  type ApiTokenRow,
} from '../../shared/access/api-token-authority.js';

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
