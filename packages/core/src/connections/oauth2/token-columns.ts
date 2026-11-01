import { and, eq, sql } from 'drizzle-orm';

import { connectionOAuth2Tokens as tokens } from '@pertexo/database/schema';

import type { IssuedOAuth2Tokens } from './contract.js';

export const sealedColumns = (issued: IssuedOAuth2Tokens) => ({
  kmsKeyReference: issued.sealed.kmsKeyReference,
  encryptedDataKey: issued.sealed.encryptedDataKey,
  ciphertext: issued.sealed.ciphertext,
  nonce: issued.sealed.nonce,
  authTag: issued.sealed.tag,
});

/** Expiry counts from the commit, by database time. */
export const expiryOf = (issued: IssuedOAuth2Tokens) =>
  issued.expiresInSeconds === null
    ? null
    : sql`clock_timestamp()+make_interval(secs=>${issued.expiresInSeconds}::double precision)`;

export const versionIs = (
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    tokenId: string;
  }>,
) =>
  and(
    eq(tokens.workspaceId, input.workspaceId),
    eq(tokens.connectionId, input.connectionId),
    eq(tokens.id, input.tokenId),
  );
