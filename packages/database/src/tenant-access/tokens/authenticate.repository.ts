import type { Pool } from 'pg';
import { withTenantScopedClient } from '../transactions.js';
import {
  matchesApiTokenDigest,
  type ParsedApiTokenCredential,
} from './credential.js';
import { apiTokenStatus, type ApiTokenRow } from './metadata.js';
import type { VerifiedApiToken } from './contract.js';

type CredentialRow = ApiTokenRow &
  Readonly<{
    owner_status: string;
    member_status: string;
    workspace_status: string;
    current_revision: number;
    observed_at: Date;
  }>;
export function authenticateApiToken(
  pool: Pool,
  input: ParsedApiTokenCredential,
  signal?: AbortSignal,
): Promise<VerifiedApiToken | undefined> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const rows = await client.query<CredentialRow>(
        `select token.*, owner_record.status owner_status, member.status member_status,
      workspace.status workspace_status, member.role_revision current_revision, clock_timestamp() observed_at
      from app.api_tokens token
      join app.users owner_record on owner_record.id=token.owner_user_id
      join app.workspace_memberships member on member.workspace_id=token.workspace_id and member.user_id=token.owner_user_id
      join app.workspaces workspace on workspace.id=token.workspace_id
      where token.workspace_id=$1 and token.id=$2`,
        [input.workspaceId, input.tokenId],
      );
      const row = rows.rows[0];
      const tokenUnavailable =
        row === undefined ||
        !matchesApiTokenDigest(input.digest, row.secret_digest) ||
        apiTokenStatus(row, row.current_revision, row.observed_at) !==
          'active' ||
        row.owner_status !== 'active' ||
        row.member_status !== 'active' ||
        row.workspace_status !== 'active';
      if (tokenUnavailable) return undefined;
      // Verification is already complete; revocation doesn't cancel admitted work.
      await client.query(
        `update app.api_tokens set last_used_at=$3 where workspace_id=$1 and id=$2
      and revoked_at is null and (last_used_at is null or last_used_at <= $3::timestamptz - interval '1 minute')`,
        [input.workspaceId, input.tokenId, row.observed_at],
      );
      return Object.freeze({
        workspaceId: row.workspace_id,
        ownerUserId: row.owner_user_id,
        tokenId: row.id,
        scopes: Object.freeze([...row.scopes]),
      });
    },
    { ...(signal === undefined ? {} : { signal }) },
  );
}
