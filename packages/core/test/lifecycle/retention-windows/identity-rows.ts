import { randomUUID } from 'node:crypto';

import { userId, workspaceId } from '../retention.support.js';
import { before, digest, hex, type WindowedRule } from './rows.js';

/** Sign-in history and security facts: see rows.ts for how a row is used. */
export const IDENTITY_RULES: readonly WindowedRule[] = [
  {
    rule: 'provisioning_credentials',
    table: 'auth_provisioning_credentials',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      organization_id: workspaceId,
      name: 'Directory sync',
      secret_digest: hex(),
      revoked_at: at,
    }),
  },
  {
    rule: 'auth_sessions',
    table: 'auth_sessions',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      token: randomUUID(),
      user_id: userId,
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_method_link_attempts',
    table: 'auth_method_link_attempts',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      user_id: userId,
      session_id: randomUUID(),
      browser_digest: digest(),
      source_provider: 'credential',
      target_provider: 'google',
      phase: 'source',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_federation_attempts',
    table: 'auth_federation_attempts',
    windowDays: 1,
    row: (at) => ({
      id: randomUUID(),
      organization_id: workspaceId,
      provider_id: randomUUID(),
      provider_revision: 1,
      domain_id: randomUUID(),
      purpose: 'sign_in',
      state_digest: digest(),
      browser_digest: digest(),
      return_path: '/',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_sign_in_attempts',
    table: 'auth_sign_in_attempts',
    windowDays: 1,
    row: (at) => ({
      id: randomUUID(),
      provider: 'google',
      state_digest: digest(),
      browser_digest: digest(),
      return_path: '/',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_email_proofs',
    table: 'auth_email_proofs',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      token_digest: digest(),
      user_id: userId,
      purpose: 'initial_verification',
      email: `${randomUUID()}@example.test`,
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'identity_security_audit_facts',
    table: 'identity_security_audit_facts',
    windowDays: 365,
    row: (at) => ({
      id: randomUUID(),
      user_id: userId,
      event_type: 'password.changed',
      occurred_at: at,
    }),
  },
  {
    rule: 'transport_security_audit_facts',
    table: 'transport_security_audit_facts',
    windowDays: 365,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      fact_type: 'inbox_checksum_mismatch',
      consumer_name: 'retention.test',
      message_id: randomUUID(),
      occurred_at: at,
    }),
  },
];
