import { timingSafeEqual } from 'node:crypto';

import { createDatabasePool } from '../postgres-telemetry.js';
import { withPlatformTransaction } from './workspace.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { IdentityConflictError } from './identity-workspace.js';

const stateDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const secretSchema = z.string().min(1).max(16_384);
const sealMetadataSchema = z.object({
  ciphertext: secretSchema,
  nonce: z.string().min(1).max(128),
  tag: z.string().min(1).max(256),
  keyVersion: z.string().min(1).max(64),
});

export type OidcLoginTransaction = Readonly<{
  stateDigest: string;
  browserBindingDigest: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: Date;
}>;

export type SealedOidcSecret = Readonly<z.output<typeof sealMetadataSchema>>;

/** Application-owned envelope/KMS adapter. Plaintext never enters persistence. */
export interface OidcSecretEncryptionAdapter {
  seal(
    plaintext: string,
    associatedData: string,
  ): Promise<SealedOidcSecret> | SealedOidcSecret;
  open(
    sealed: SealedOidcSecret,
    associatedData: string,
  ): Promise<string> | string;
}

export type OidcTransactionConsumeResult = Readonly<{
  status: 'ok' | 'missing' | 'expired' | 'replayed' | 'binding_mismatch';
  transaction?: OidcLoginTransaction;
}>;

export class OidcTransactionSealingError extends Error {
  public override readonly name = 'OidcTransactionSealingError';
}

export class OidcTransactionCapacityError extends Error {
  public override readonly name = 'OidcTransactionCapacityError';
}

export type OidcLoginTransactionStore = Readonly<{
  create(transaction: OidcLoginTransaction): Promise<void>;
  consume(
    stateDigest: string,
    browserBindingDigest: string,
    now: Date,
  ): Promise<OidcTransactionConsumeResult>;
  close(): Promise<void>;
}>;

function associatedData(
  stateDigest: string,
  field: 'code_verifier' | 'nonce',
): string {
  return `pertexo/oidc-login/${stateDigest}/${field}`;
}

function parseSealed(value: SealedOidcSecret): SealedOidcSecret {
  return sealMetadataSchema.parse(value);
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error && (error as { code?: string }).code === '23505'
  );
}

function isCapacityExhausted(error: unknown): boolean {
  return (
    error instanceof Error && (error as { code?: string }).code === '54000'
  );
}

export function createOidcLoginTransactionStore(
  config: DatabaseConfig,
  encryption: OidcSecretEncryptionAdapter,
): OidcLoginTransactionStore {
  const pool = createDatabasePool(config);

  return Object.freeze({
    create: async (transaction: OidcLoginTransaction): Promise<void> => {
      const stateDigest = stateDigestSchema.parse(transaction.stateDigest);
      const browserBindingDigest = stateDigestSchema.parse(
        transaction.browserBindingDigest,
      );
      if (
        !(transaction.expiresAt instanceof Date) ||
        transaction.expiresAt.getTime() <= Date.now()
      ) {
        throw new Error('OIDC transaction expiry must be in the future');
      }
      const codeVerifier = await encryption.seal(
        transaction.codeVerifier,
        associatedData(stateDigest, 'code_verifier'),
      );
      const nonce = await encryption.seal(
        transaction.nonce,
        associatedData(stateDigest, 'nonce'),
      );
      const sealedCodeVerifier = parseSealed(codeVerifier);
      const sealedNonce = parseSealed(nonce);
      try {
        await pool.query(
          `insert into app.oidc_login_transactions
             (state_digest, code_verifier_ciphertext, code_verifier_nonce,
              code_verifier_tag, code_verifier_key_version,
              nonce_ciphertext, nonce_nonce, nonce_tag, nonce_key_version,
              browser_binding_digest, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            stateDigest,
            sealedCodeVerifier.ciphertext,
            sealedCodeVerifier.nonce,
            sealedCodeVerifier.tag,
            sealedCodeVerifier.keyVersion,
            sealedNonce.ciphertext,
            sealedNonce.nonce,
            sealedNonce.tag,
            sealedNonce.keyVersion,
            browserBindingDigest,
            transaction.expiresAt,
          ],
        );
      } catch (error: unknown) {
        if (isConflict(error)) {
          throw new IdentityConflictError('OIDC login state already exists', {
            cause: error,
          });
        }
        if (isCapacityExhausted(error)) {
          throw new OidcTransactionCapacityError(
            'OIDC login transaction capacity is exhausted',
            { cause: error },
          );
        }
        throw error;
      }
    },

    consume: async (
      stateDigestInput: string,
      browserBindingDigestInput: string,
      now: Date,
    ): Promise<OidcTransactionConsumeResult> => {
      const stateDigest = stateDigestSchema.parse(stateDigestInput);
      const browserBindingDigest = stateDigestSchema.parse(
        browserBindingDigestInput,
      );
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('OIDC transaction consume time is invalid');
      }
      const result = await withPlatformTransaction(pool, async (client) => {
        const locked = await client.query(
          `select state_digest, browser_binding_digest,
                  code_verifier_ciphertext, code_verifier_nonce,
                  code_verifier_tag, code_verifier_key_version,
                  nonce_ciphertext, nonce_nonce, nonce_tag, nonce_key_version,
                  expires_at, consumed_at
           from app.oidc_login_transactions
           where state_digest = $1
           for update`,
          [stateDigest],
        );
        const row = locked.rows[0] as Record<string, unknown> | undefined;
        if (row === undefined) return { status: 'missing' as const };
        if (row.consumed_at !== null) return { status: 'replayed' as const };
        if (z.coerce.date().parse(row.expires_at).getTime() <= now.getTime())
          return { status: 'expired' as const };
        if (
          !constantTimeDigestEqual(
            stateDigestSchema.parse(row.browser_binding_digest),
            browserBindingDigest,
          )
        ) {
          return { status: 'binding_mismatch' as const };
        }
        await client.query(
          `update app.oidc_login_transactions
           set consumed_at = clock_timestamp()
           where state_digest = $1`,
          [stateDigest],
        );
        return { status: 'ok' as const, row };
      });
      if (result.status !== 'ok') return result;
      const consumedRow = result.row;
      try {
        const sealedCodeVerifier = parseSealed({
          ciphertext: String(consumedRow.code_verifier_ciphertext),
          nonce: String(consumedRow.code_verifier_nonce),
          tag: String(consumedRow.code_verifier_tag),
          keyVersion: String(consumedRow.code_verifier_key_version),
        });
        const sealedNonce = parseSealed({
          ciphertext: String(consumedRow.nonce_ciphertext),
          nonce: String(consumedRow.nonce_nonce),
          tag: String(consumedRow.nonce_tag),
          keyVersion: String(consumedRow.nonce_key_version),
        });
        const [codeVerifier, nonce] = await Promise.all([
          encryption.open(
            sealedCodeVerifier,
            associatedData(stateDigest, 'code_verifier'),
          ),
          encryption.open(sealedNonce, associatedData(stateDigest, 'nonce')),
        ]);
        return {
          status: 'ok',
          transaction: Object.freeze({
            stateDigest,
            browserBindingDigest,
            codeVerifier,
            nonce,
            expiresAt: z.coerce.date().parse(consumedRow.expires_at),
          }),
        };
      } catch (error: unknown) {
        throw new OidcTransactionSealingError(
          'OIDC transaction secret could not be opened',
          {
            cause: error,
          },
        );
      }
    },

    close: async (): Promise<void> => pool.end(),
  });
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
