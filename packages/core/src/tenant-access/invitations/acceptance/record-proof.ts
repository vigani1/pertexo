import { readDatabaseClock } from '../../../shared/database-clock.repository.js';
import { InvitationAcceptanceConflictError } from '../../tenant-access.errors.js';
import { canonicalEmail } from '../../../identity/email-policy.js';
import { INVITATION_PROOF_TTL_MILLIS } from './decide-invitation-acceptance.js';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.repository.js';
import { withWorkspaceScope } from '@pertexo/database/primitives';
import { workspaceInvitationAcceptanceIntents as intents } from '@pertexo/database/schema';
import { withPlatformTransaction } from '@pertexo/database/platform';
import type {
  InvitationAcceptanceIntentRecord,
  RecordInvitationAcceptanceProofInput,
} from '../../tenant-access.types.js';
import { OPEN_INTENT_STATUSES } from '../open-intents.repository.js';
import { selectIntent } from './state.repository.js';
import {
  lockIntentForProof,
  recordIntentVerification,
} from './proof.repository.js';

export async function recordInvitationAcceptanceProof(
  pool: Pool,
  raw: RecordInvitationAcceptanceProofInput,
): Promise<InvitationAcceptanceIntentRecord | null> {
  const workspaceId = raw.workspaceId;
  const intentId = raw.intentId;
  const userId = raw.userId;
  const bindingDigest = raw.bindingDigest;
  const normalizedEmail = raw.verifiedEmail;
  return withPlatformTransaction(pool, async (client) => {
    const source = await readEligibleAuthenticationSession(
      client,
      raw.sessionId,
    );
    if (source?.userId !== userId) return null;
    return withWorkspaceScope(client, { workspaceId }, async (client) => {
      const key = { workspaceId, intentId, bindingDigest };
      const current = await lockIntentForProof(client, key);
      const now = await readDatabaseClock(client);
      if (
        current === undefined ||
        current.expires_at.getTime() <= now.getTime()
      )
        return null;
      if (current.status === 'completed')
        return current.accepted_user_id === userId
          ? selectIntent(client, eq(intents.id, intentId))
          : null;
      if (!(OPEN_INTENT_STATUSES as readonly string[]).includes(current.status))
        return null;
      if (
        now.getTime() - raw.verifiedAt.getTime() >
        INVITATION_PROOF_TTL_MILLIS
      )
        throw new InvitationAcceptanceConflictError(
          'proof_expired',
          'Sign in again before verifying the invitation',
        );
      const matches =
        canonicalEmail(current.recipient_email) === normalizedEmail;
      await recordIntentVerification(client, key, raw, matches);
      return selectIntent(client, eq(intents.id, intentId));
    });
  });
}
