import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { PurgeSeed } from '../base.js';

export async function seedPurgeRelationships(
  owner: Pool,
  ids: PurgeSeed,
): Promise<void> {
  const {
    workspaceId,
    userId,
    replacementPriorIntentId,
    replacementSuccessorIntentId,
    externalWorkspaceId,
    externalInvitationId,
    externalIntentId,
    externalClaimPriorIntentId,
    incomingClaimPriorIntentId,
  } = ids;
  await owner.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Purge owner')",
    [userId, `${userId}@example.test`],
  );
  await owner.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge fixture',$2,$3)",
    [workspaceId, `purge-${workspaceId}`, userId],
  );
  await owner.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",
    [workspaceId, userId],
  );
  await owner.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge external successor',$2,$3)",
    [externalWorkspaceId, `purge-external-${externalWorkspaceId}`, userId],
  );
  await owner.query(
    `insert into app.workspace_invitations
          (id,workspace_id,recipient_email,normalized_email,role,status,revision,
           token_digest,delivery_status,created_by,expires_at)
         values($1,$2,$3,$3,'viewer','pending',1,$4,'submitted',$5,
           clock_timestamp()+interval '1 day')`,
    [
      externalInvitationId,
      externalWorkspaceId,
      `${externalInvitationId}@example.test`,
      'd'.repeat(64),
      userId,
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_acceptance_intents
          (id,workspace_id,invitation_id,invitation_revision,binding_digest,
           csrf_digest,status,expires_at)
         values($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '10 minutes')`,
    [
      externalIntentId,
      externalWorkspaceId,
      externalInvitationId,
      'e'.repeat(64),
      'f'.repeat(64),
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
    [
      workspaceId,
      replacementPriorIntentId,
      'a'.repeat(64),
      replacementSuccessorIntentId,
      randomUUID(),
      'b'.repeat(64),
      'c'.repeat(64),
    ],
  );
  for (let ordinal = 1; ordinal <= 10; ordinal += 1)
    await owner.query(
      `insert into app.workspace_invitation_binding_replacement_claims
            (prior_workspace_id,prior_intent_id,prior_binding_digest,
             successor_workspace_id,successor_intent_id,successor_invitation_id,
             successor_invitation_revision,successor_binding_digest,
             successor_csrf_digest,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,1,$7,$8,
             timestamptz '2025-01-01 00:00:00+00'+$9*interval '1 second',
             timestamptz '2025-01-01 00:00:00+00'+$9*interval '1 second')`,
      [
        workspaceId,
        randomUUID(),
        ordinal.toString(16).padStart(64, '0'),
        externalWorkspaceId,
        randomUUID(),
        randomUUID(),
        (ordinal + 16).toString(16).padStart(64, '0'),
        (ordinal + 32).toString(16).padStart(64, '0'),
        ordinal,
      ],
    );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$4,$5,$6,1,$7,$8)`,
    [
      workspaceId,
      externalClaimPriorIntentId,
      '1'.repeat(64),
      externalWorkspaceId,
      externalIntentId,
      externalInvitationId,
      'e'.repeat(64),
      'f'.repeat(64),
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$4,$5,$6,1,$7,$8)`,
    [
      externalWorkspaceId,
      incomingClaimPriorIntentId,
      '4'.repeat(64),
      workspaceId,
      randomUUID(),
      randomUUID(),
      '5'.repeat(64),
      '6'.repeat(64),
    ],
  );
}
