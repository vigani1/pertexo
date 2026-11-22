import type { apiTokens } from '@pertexo/database/schema';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import type { readApiTokenAuthority } from './api-token-authority.repository.js';

export type ApiTokenRow = typeof apiTokens.$inferSelect;

function apiTokenStatus(
  row: ApiTokenRow,
  membershipRevision: number,
  now: Date,
): ApiTokenMetadata['status'] {
  return row.revokedAt === null
    ? unrevokedTokenStatus(row, membershipRevision, now)
    : 'revoked';
}

export function unrevokedTokenStatus(
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

export function isActiveApiToken(
  row: NonNullable<Awaited<ReturnType<typeof readApiTokenAuthority>>>,
): boolean {
  return (
    apiTokenStatus(row, row.currentRevision, row.observedAt) === 'active' &&
    row.ownerStatus === 'active' &&
    row.memberStatus === 'active' &&
    row.workspaceStatus === 'active'
  );
}
