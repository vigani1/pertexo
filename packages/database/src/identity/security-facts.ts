import type { PoolClient } from 'pg';

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
  | 'profile.display_name_changed';

/** Records a security fact about a user in the caller's transaction. */
export async function recordIdentitySecurityFact(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  event: IdentitySecurityEvent,
): Promise<void> {
  await client.query(
    `insert into app.identity_security_audit_facts (id, user_id, event_type)
     values ($1, $2, $3)`,
    [generatePersistedId(), userId, event],
  );
}
