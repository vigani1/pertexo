import type { ApiTokenMetadata, ApiTokenScope } from '@pertexo/contracts';

export type ApiTokenRow = Readonly<{
  id: string;
  workspace_id: string;
  owner_user_id: string;
  name: string;
  secret_digest: string;
  scopes: ApiTokenScope[];
  membership_revision: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}>;
export function apiTokenStatus(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata['status'] {
  return row.revoked_at !== null
    ? 'revoked'
    : row.membership_revision !== membershipRevision
      ? 'membership_changed'
      : row.expires_at <= now
        ? 'expired'
        : 'active';
}

export function apiTokenMetadata(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    scopes: row.scopes,
    status: apiTokenStatus(row, membershipRevision, now),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}
