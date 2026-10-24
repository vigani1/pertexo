import type { SystemMailPurpose } from '../../platform/mail/contract.js';
import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  index,
  integer,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const systemMailDeliveries = appSchema.table(
  'system_mail_deliveries',
  {
    id: uuid().primaryKey().notNull(),
    purpose: varchar({ length: 32 }).$type<SystemMailPurpose>().notNull(),
    status: varchar({ length: 32 }).default('queued').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseGeneration: bigint('lease_generation', { mode: 'number' })
      .default(0)
      .notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    payloadCiphertext: text('payload_ciphertext'),
    payloadNonce: varchar('payload_nonce', { length: 128 }),
    payloadTag: varchar('payload_tag', { length: 256 }),
    payloadKeyVersion: varchar('payload_key_version', { length: 64 }),
    providerReference: varchar('provider_reference', { length: 512 }),
    failureCode: varchar('failure_code', { length: 128 }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'system_mail_active_has_payload',
      sql`(((status)::text <> ALL (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text])) OR (payload_ciphertext IS NOT NULL))`,
    ),
    check(
      'system_mail_attempts_bounded',
      sql`((attempt_count >= 0) AND (attempt_count <= 12))`,
    ),
    check('system_mail_expiry_after_creation', sql`(expires_at > created_at)`),
    check(
      'system_mail_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))`,
    ),
    check(
      'system_mail_payload_complete',
      sql`(((payload_ciphertext IS NULL) AND (payload_nonce IS NULL) AND (payload_tag IS NULL) AND (payload_key_version IS NULL)) OR ((payload_ciphertext IS NOT NULL) AND (payload_nonce IS NOT NULL) AND (payload_tag IS NOT NULL) AND (payload_key_version IS NOT NULL)))`,
    ),
    check(
      'system_mail_purpose_valid',
      sql`((purpose)::text = ANY (ARRAY[('verification'::character varying)::text, ('password_reset'::character varying)::text, ('email_change_confirmation'::character varying)::text, ('workspace_notice'::character varying)::text, ('two_factor_disabled'::character varying)::text, ('recovery_code_sign_in'::character varying)::text]))`,
    ),
    check(
      'system_mail_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text]))`,
    ),
    index('system_mail_due_idx')
      .on(table.nextAttemptAt, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text]))`,
      ),
    index('system_mail_retention_idx')
      .on(table.completedAt, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text]))`,
      ),
  ],
);
