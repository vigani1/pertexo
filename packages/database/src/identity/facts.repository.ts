import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { identitySecurityAuditFacts } from '../schema/authentication.js';

import { generatePersistedId } from '../platform/persisted-id.js';

/** What changed about a user's sign-in methods, email or profile. */
export type IdentitySecurityEvent =
  | 'email.initial_verified'
  | 'email.old_confirmed'
  | 'email.change_verified'
  | 'method.linked'
  | 'method.unlinked'
  | 'password.changed'
  | 'password.configured'
  | 'password.reset'
  | 'profile.display_name_changed'
  | 'session.signed_in'
  | 'two_factor.disabled'
  | 'two_factor.recovery_code_used'
  | 'two_factor.operator_disabled';

/** Accepts the caller's transaction when the fact must commit with an identity change. */
export async function recordIdentitySecurityFact(
  client: Pool | PoolClient,
  userId: string,
  event: IdentitySecurityEvent,
): Promise<void> {
  await drizzle(client).insert(identitySecurityAuditFacts).values({
    id: generatePersistedId(),
    userId,
    eventType: event,
  });
}
