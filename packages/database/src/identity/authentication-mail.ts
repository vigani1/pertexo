import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';

const purpose = z.enum([
  'verification',
  'password_reset',
  'email_change_confirmation',
]);
const sealedPayload = z
  .object({
    ciphertext: z.string().min(1).max(32_768),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();

export type AuthenticationMailPurpose = z.infer<typeof purpose>;
export type SealedAuthenticationMailPayload = z.infer<typeof sealedPayload>;

export interface AuthenticationMailEnqueueStore {
  enqueue(
    input: Readonly<{
      id: string;
      purpose: AuthenticationMailPurpose;
      expiresAt: Date;
      sealedPayload: SealedAuthenticationMailPayload;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}

export type AuthenticationMailDeliveryClaim = Readonly<{
  id: string;
  purpose: AuthenticationMailPurpose;
  expiresAt: Date;
  attemptCount: number;
  leaseGeneration: number;
  leaseToken: string;
  sealedPayload: SealedAuthenticationMailPayload;
}>;

export interface AuthenticationMailDeliveryStore {
  claim(
    input: Readonly<{ workerId: string; limit: number }>,
  ): Promise<readonly AuthenticationMailDeliveryClaim[]>;
  settle(
    input: Readonly<{
      id: string;
      leaseToken: string;
      leaseGeneration: number;
      outcome: 'submitted' | 'failed' | 'retry' | 'reconciliation_required';
      providerReference?: string;
      failureCode?: string;
      retryAt?: Date;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export function createAuthenticationMailEnqueueStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): AuthenticationMailEnqueueStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'api' });
  return Object.freeze({
    enqueue: async (
      input: Parameters<AuthenticationMailEnqueueStore['enqueue']>[0],
    ) => {
      const sealed = sealedPayload.parse(input.sealedPayload);
      await lease.pool.query(
        `select app.enqueue_authentication_mail($1,$2,$3,$4,$5,$6,$7)`,
        [
          z.uuid().parse(input.id),
          purpose.parse(input.purpose),
          z.date().parse(input.expiresAt),
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.keyVersion,
        ],
      );
    },
    close: () => lease.close(),
  });
}

export function createAuthenticationMailDeliveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): AuthenticationMailDeliveryStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  return Object.freeze({
    claim: async (
      input: Parameters<AuthenticationMailDeliveryStore['claim']>[0],
    ) => {
      const leaseToken = randomUUID();
      const result = await lease.pool.query<{
        id: string;
        purpose: string;
        expires_at: Date;
        attempt_count: number;
        lease_generation: string;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
      }>(`select * from app.claim_authentication_mail($1,$2,$3)`, [
        z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
          .parse(input.workerId),
        z.number().int().min(1).max(50).parse(input.limit),
        leaseToken,
      ]);
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            id: z.uuid().parse(row.id),
            purpose: purpose.parse(row.purpose),
            expiresAt: z.coerce.date().parse(row.expires_at),
            attemptCount: z
              .number()
              .int()
              .positive()
              .max(12)
              .parse(row.attempt_count),
            leaseGeneration: z.coerce
              .number()
              .int()
              .positive()
              .parse(row.lease_generation),
            leaseToken,
            sealedPayload: sealedPayload.parse({
              ciphertext: row.payload_ciphertext,
              nonce: row.payload_nonce,
              tag: row.payload_tag,
              keyVersion: row.payload_key_version,
            }),
          }),
        ),
      );
    },
    settle: async (
      input: Parameters<AuthenticationMailDeliveryStore['settle']>[0],
    ) => {
      const result = await lease.pool.query<{ settled: boolean }>(
        `select app.settle_authentication_mail($1,$2,$3,$4,$5,$6,$7) settled`,
        [
          z.uuid().parse(input.id),
          z.uuid().parse(input.leaseToken),
          z.number().int().positive().parse(input.leaseGeneration),
          input.outcome,
          input.providerReference ?? null,
          input.failureCode ?? null,
          input.retryAt ?? null,
        ],
      );
      return result.rows[0]?.settled === true;
    },
    close: () => lease.close(),
  });
}
