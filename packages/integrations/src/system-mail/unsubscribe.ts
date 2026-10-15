import { z } from 'zod';
import type { ApplicationSecretEnvelope } from '../security/application-secret-envelope.js';
const claimsSchema = z
  .object({
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    revision: z.number().int().nonnegative(),
    memberRevision: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type NoticeUnsubscribeClaims = z.output<typeof claimsSchema>;
const sealedSchema = z
  .object({
    ciphertext: z.string().max(2048),
    nonce: z.string().max(128),
    tag: z.string().max(128),
    keyVersion: z.string().max(64),
  })
  .strict();
const associatedData = 'pertexo/notice-unsubscribe';
export function sealNoticeUnsubscribe(
  envelope: Pick<ApplicationSecretEnvelope, 'seal'>,
  claims: NoticeUnsubscribeClaims,
): string {
  return Buffer.from(
    JSON.stringify(
      envelope.seal(JSON.stringify(claimsSchema.parse(claims)), associatedData),
    ),
  ).toString('base64url');
}
export function openNoticeUnsubscribe(
  envelope: Pick<ApplicationSecretEnvelope, 'open'>,
  token: string,
  now: Date,
): NoticeUnsubscribeClaims | null {
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(token)) return null;
    const sealed = sealedSchema.parse(
      JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown,
    );
    const claims = claimsSchema.parse(
      JSON.parse(envelope.open(sealed, associatedData)) as unknown,
    );
    return Date.parse(claims.expiresAt) > now.getTime() ? claims : null;
  } catch {
    return null;
  }
}
