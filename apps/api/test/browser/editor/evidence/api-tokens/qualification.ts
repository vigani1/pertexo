import { z } from 'zod';
import { expect } from 'vitest';
import type { Pool } from 'pg';

export const apiTokensEvidenceSchema = z.strictObject({
  owners: z
    .array(
      z.strictObject({
        workspaceId: z.uuid(),
        ownerUserId: z.uuid(),
        tokenId: z.uuid(),
      }),
    )
    .length(2),
});

export async function verifyApiTokensEvidence(
  database: Pool,
  evidence: z.infer<typeof apiTokensEvidenceSchema>,
) {
  for (const owner of evidence.owners) {
    const rows = await database.query<{
      id: string;
      owner_user_id: string;
      revoked: boolean;
      used: boolean;
      digest_valid: boolean;
      scopes: string[];
      membership_revision: number;
      role_revision: number;
    }>(
      `select token.id,token.owner_user_id,token.revoked_at is not null revoked,
      token.last_used_at is not null used,token.secret_digest ~ '^[0-9a-f]{64}$' digest_valid,
      token.scopes,token.membership_revision,member.role_revision
      from app.api_tokens token join app.workspace_memberships member
      on member.workspace_id=token.workspace_id and member.user_id=token.owner_user_id
      where token.workspace_id=$1`,
      [owner.workspaceId],
    );
    expect(rows.rows).toEqual([
      {
        id: owner.tokenId,
        owner_user_id: owner.ownerUserId,
        revoked: true,
        used: true,
        digest_valid: true,
        scopes: ['run:read', 'workflow:read'],
        membership_revision: 1,
        role_revision: 1,
      },
    ]);
    const audit = await database.query<{
      action: string;
      actor_user_id: string;
      metadata: unknown;
    }>(
      'select action,actor_user_id,metadata from app.audit_events where workspace_id=$1 and target_id=$2 order by action',
      [owner.workspaceId, owner.tokenId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'api.token.created',
        actor_user_id: owner.ownerUserId,
        metadata: {},
      },
      {
        action: 'api.token.revoked',
        actor_user_id: owner.ownerUserId,
        metadata: {},
      },
    ]);
    const receipts = await database.query<{ result_ref: unknown }>(
      'select result_ref from app.idempotency_records where workspace_id=$1 and resource_id=$2',
      [owner.workspaceId, owner.tokenId],
    );
    expect(receipts.rows).toHaveLength(2);
    for (const receipt of receipts.rows)
      expect(receipt.result_ref).toEqual({ tokenId: owner.tokenId });
  }
}
