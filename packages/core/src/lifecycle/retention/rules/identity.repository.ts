import {
  authProvisioningCredentials,
  authSessions,
  authMethodLinkAttempts,
  authEmailProofs,
  identitySecurityAuditFacts,
  authFederationAttempts,
  authSignInAttempts,
  systemMailDeliveries,
} from '@pertexo/database/schema';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { deletionRule } from '../../../shared/retention-deletion.repository.js';
import { SYSTEM_MAIL_DELIVERY_BUDGET } from '@pertexo/secrets/server';
import {
  DAY_INTERVAL,
  HOUR_INTERVAL,
} from '../../../shared/sql-intervals.repository.js';

/** How long each identity record is kept once it has expired or ended. */
const IDENTITY_RETENTION_DAYS = Object.freeze({
  provisioningCredentials: 30,
  // Kept 30 days after they end, for sign-in history.
  sessions: 30,
  methodLinkAttempts: 30,
  federationAttempts: 1,
  signInAttempts: 1,
  emailProofs: 30,
  securityFacts: 365,
  authenticationMail: 30,
});

const expiredProvisioning = sql`${authProvisioningCredentials.revokedAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.provisioningCredentials}*${DAY_INTERVAL}`;
export const provisioningCredentials = deletionRule(
  'provisioning_credentials',
  {
    table: authProvisioningCredentials,
    keys: [authProvisioningCredentials.id],
    condition: expiredProvisioning,
    orderBy: [authProvisioningCredentials.id],
    recheck: expiredProvisioning,
  },
);
const expiredSessions = sql`${authSessions.expiresAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.sessions}*${DAY_INTERVAL}`;
export const sessions = deletionRule('auth_sessions', {
  table: authSessions,
  keys: [authSessions.id],
  condition: expiredSessions,
  orderBy: [authSessions.expiresAt, authSessions.id],
  recheck: expiredSessions,
});
export const methodLinkAttempts = deletionRule('auth_method_link_attempts', {
  table: authMethodLinkAttempts,
  keys: [authMethodLinkAttempts.id],
  condition: sql`${authMethodLinkAttempts.expiresAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.methodLinkAttempts}*${DAY_INTERVAL}`,
  orderBy: [authMethodLinkAttempts.expiresAt, authMethodLinkAttempts.id],
});
export const federationAttempts = deletionRule('auth_federation_attempts', {
  table: authFederationAttempts,
  keys: [authFederationAttempts.id],
  condition: sql`${authFederationAttempts.expiresAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.federationAttempts}*${DAY_INTERVAL}`,
  orderBy: [authFederationAttempts.expiresAt, authFederationAttempts.id],
});
export const signInAttempts = deletionRule('auth_sign_in_attempts', {
  table: authSignInAttempts,
  keys: [authSignInAttempts.id],
  condition: sql`${authSignInAttempts.expiresAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.signInAttempts}*${DAY_INTERVAL}`,
  orderBy: [authSignInAttempts.expiresAt, authSignInAttempts.id],
});
export const emailProofs = deletionRule('auth_email_proofs', {
  table: authEmailProofs,
  keys: [authEmailProofs.id],
  condition: sql`${authEmailProofs.expiresAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.emailProofs}*${DAY_INTERVAL}`,
  orderBy: [authEmailProofs.expiresAt, authEmailProofs.id],
});
export const identityFacts = deletionRule('identity_security_audit_facts', {
  table: identitySecurityAuditFacts,
  keys: [identitySecurityAuditFacts.id],
  condition: sql`${identitySecurityAuditFacts.occurredAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.securityFacts}*${DAY_INTERVAL}`,
  orderBy: [
    identitySecurityAuditFacts.occurredAt,
    identitySecurityAuditFacts.id,
  ],
});
export const authenticationMail = deletionRule('authentication_mail', {
  table: systemMailDeliveries,
  keys: [systemMailDeliveries.id],
  condition: and(
    inArray(systemMailDeliveries.status, [
      'submitted',
      'failed',
      'reconciliation_required',
      'expired',
    ]),
    sql`${systemMailDeliveries.completedAt}<=clock_timestamp()-${IDENTITY_RETENTION_DAYS.authenticationMail}*${DAY_INTERVAL}`,
  ),
  orderBy: [systemMailDeliveries.completedAt, systemMailDeliveries.id],
});

// Mail past its delivery budget (secrets' window or attempts) is given up:
// its sealed payload is dropped and an operator reconciles it.
// These durable maintenance rule identities predate the system-mail table name.
export const unsentAuthenticationMail = {
  name: 'unsent_authentication_mail',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({ id: systemMailDeliveries.id })
        .from(systemMailDeliveries)
        .where(
          and(
            inArray(systemMailDeliveries.status, [
              'queued',
              'outcome_unknown',
              'retry',
            ]),
            or(
              lte(systemMailDeliveries.expiresAt, sql`clock_timestamp()`),
              sql`${systemMailDeliveries.createdAt}+${SYSTEM_MAIL_DELIVERY_BUDGET.windowHours}*${HOUR_INTERVAL}<=clock_timestamp()`,
              gte(
                systemMailDeliveries.attemptCount,
                SYSTEM_MAIL_DELIVERY_BUDGET.maxAttempts,
              ),
            ),
            or(
              isNull(systemMailDeliveries.leaseExpiresAt),
              lte(systemMailDeliveries.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          ),
        )
        .orderBy(
          asc(systemMailDeliveries.createdAt),
          asc(systemMailDeliveries.id),
        )
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .update(systemMailDeliveries)
        .set({
          status: sql`case when ${systemMailDeliveries.expiresAt}<=clock_timestamp() then 'expired' else 'reconciliation_required' end`,
          hadUncertainAttempt: sql`${systemMailDeliveries.hadUncertainAttempt} or ${systemMailDeliveries.status}='outcome_unknown'`,
          payloadCiphertext: null,
          payloadNonce: null,
          payloadTag: null,
          payloadKeyVersion: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(eq(systemMailDeliveries.id, page.id))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
