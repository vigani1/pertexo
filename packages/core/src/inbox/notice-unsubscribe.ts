import { z } from 'zod';
import type { ApplicationSecretEnvelope } from '@pertexo/secrets/server';
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
// The longest token a sealed claim set encodes to.
const TOKEN_MAX_CHARACTERS = 4096;
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
    if (token.length > TOKEN_MAX_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(token))
      return null;
    // The envelope checks the sealed shape as it opens it.
    const sealed: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    const claims = claimsSchema.parse(
      JSON.parse(envelope.open(sealed, associatedData)) as unknown,
    );
    return Date.parse(claims.expiresAt) > now.getTime() ? claims : null;
  } catch {
    return null;
  }
}
