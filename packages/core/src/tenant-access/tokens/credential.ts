import { apiTokenCredentialSchema } from '@pertexo/workflow-model';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ParsedApiTokenCredential = Readonly<{
  workspaceId: string;
  tokenId: string;
  digest: string;
}>;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** IDs are public routing data; only the full credential's digest authenticates. */
export function parseApiTokenCredential(
  value: unknown,
): ParsedApiTokenCredential | undefined {
  const parsed = apiTokenCredentialSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const [, workspaceId, tokenId] = parsed.data.split('.') as [
    string,
    string,
    string,
    string,
  ];
  return Object.freeze({
    workspaceId,
    tokenId,
    digest: digest(parsed.data),
  });
}
export function issueApiTokenCredential(
  workspaceId: string,
  tokenId: string,
): Readonly<{ secret: string; digest: string }> {
  const secret = `ptx_1.${workspaceId}.${tokenId}.${randomBytes(32).toString('base64url')}`;
  return Object.freeze({ secret, digest: digest(secret) });
}
export function matchesApiTokenDigest(
  candidate: string,
  stored: string,
): boolean {
  return timingSafeEqual(
    Buffer.from(candidate, 'hex'),
    Buffer.from(stored, 'hex'),
  );
}
