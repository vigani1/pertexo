import { Pool } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
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
  status: 'ok' | 'missing' | 'expired' | 'replayed';
  transaction?: OidcLoginTransaction;
}>;

export class OidcTransactionSealingError extends Error {
  public override readonly name = 'OidcTransactionSealingError';
}

export type OidcLoginTransactionStore = Readonly<{
  create(transaction: OidcLoginTransaction): Promise<void>;
  consume(
    stateDigest: string,
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

export function createOidcLoginTransactionStore(
  config: DatabaseConfig,
  encryption: OidcSecretEncryptionAdapter,
): OidcLoginTransactionStore {
  const pool = new Pool(config);

  return Object.freeze({
    create: async (transaction: OidcLoginTransaction): Promise<void> => {
      const stateDigest = stateDigestSchema.parse(transaction.stateDigest);
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
              expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
            transaction.expiresAt,
          ],
        );
      } catch (error: unknown) {
        if (isConflict(error)) {
          throw new IdentityConflictError('OIDC login state already exists', {
            cause: error,
          });
        }
        throw error;
      }
    },

    consume: async (
      stateDigestInput: string,
      now: Date,
    ): Promise<OidcTransactionConsumeResult> => {
      const stateDigest = stateDigestSchema.parse(stateDigestInput);
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('OIDC transaction consume time is invalid');
      }
      const consumed = await pool.query(
        `update app.oidc_login_transactions
         set consumed_at = clock_timestamp()
         where state_digest = $1 and consumed_at is null and expires_at > $2
         returning state_digest, code_verifier_ciphertext, code_verifier_nonce,
                   code_verifier_tag, code_verifier_key_version,
                   nonce_ciphertext, nonce_nonce, nonce_tag, nonce_key_version,
                   expires_at`,
        [stateDigest, now],
      );
      const consumedRow = consumed.rows[0] as
        Record<string, unknown> | undefined;
      if (consumedRow !== undefined) {
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
              codeVerifier,
              nonce,
              expiresAt: new Date(consumedRow.expires_at as string | Date),
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
      }

      const state = await pool.query(
        `select expires_at, consumed_at
         from app.oidc_login_transactions
         where state_digest = $1`,
        [stateDigest],
      );
      const stateRow = state.rows[0] as
        | { expires_at: string | Date; consumed_at: string | Date | null }
        | undefined;
      if (stateRow === undefined) return { status: 'missing' };
      if (stateRow.consumed_at !== null) return { status: 'replayed' };
      if (new Date(stateRow.expires_at).getTime() <= now.getTime())
        return { status: 'expired' };
      // A concurrent consumer can commit between the guarded UPDATE and this
      // classification query. Re-read as replay rather than ever returning
      // plaintext or allowing a second successful consume.
      return { status: 'replayed' };
    },

    close: async (): Promise<void> => pool.end(),
  });
}
