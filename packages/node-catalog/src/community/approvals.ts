import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CONNECTION_PROVIDER_KEY_PATTERN,
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import { compareOrdinal, isRecord } from '@pertexo/workflow-model';
import {
  COMMUNITY_MANIFEST_LIMITS,
  isCommunityOrigin,
} from '@pertexo/integrations/server';
import { CommunityApprovalError } from './approval.errors.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const APPROVAL_FIELDS = [
  'file',
  'providerKey',
  'version',
  'sha256',
  'origin',
] as const;
export type CommunityApproval = Readonly<
  Record<(typeof APPROVAL_FIELDS)[number], string> & { current: boolean }
>;
export type CommunityApprovalSet = Readonly<{
  root: string;
  approvals: readonly CommunityApproval[];
}>;

export function parseCommunityApprovalSet(
  root: string | undefined,
  json: string | undefined,
  expectedDigest?: string,
): CommunityApprovalSet | undefined {
  if (expectedDigest === '') expectedDigest = undefined;
  if (json === undefined && expectedDigest === undefined) return undefined;
  json ??= '[]';
  if (Buffer.byteLength(json) > COMMUNITY_MANIFEST_LIMITS.bytes)
    throw new CommunityApprovalError('approval list exceeds its byte limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new CommunityApprovalError(
      'COMMUNITY_INTEGRATION_APPROVALS must be JSON',
      { cause },
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > COMMUNITY_MANIFEST_LIMITS.releases
  )
    throw new CommunityApprovalError(
      'COMMUNITY_INTEGRATION_APPROVALS must be a bounded JSON array',
    );
  const entries = parsed.map(parseApproval);
  const counts = new Map<string, number>();
  for (const { providerKey } of entries)
    counts.set(providerKey, (counts.get(providerKey) ?? 0) + 1);
  const approvals = entries.map((entry) =>
    Object.freeze({
      ...entry,
      current: entry.current ?? counts.get(entry.providerKey) === 1,
    }),
  );
  if (
    expectedDigest !== undefined &&
    communityApprovalDigest(approvals) !== expectedDigest
  )
    throw new CommunityApprovalError(
      'approved set digest does not match deployment',
    );
  if (approvals.length === 0) return undefined;
  if (root === undefined || !path.isAbsolute(root))
    throw new CommunityApprovalError(
      'COMMUNITY_INTEGRATION_ROOT must be an absolute path',
    );
  return Object.freeze({
    root: path.resolve(root),
    approvals: Object.freeze(approvals),
  });
}

export function communityApprovalDigest(
  approvals: readonly CommunityApproval[],
): string {
  const releases = approvals.map(
    ({ providerKey, version, sha256, origin, current }) =>
      JSON.stringify([providerKey, version, sha256, origin, current]),
  );
  return createHash('sha256')
    .update(JSON.stringify(releases.sort(compareOrdinal)))
    .digest('hex');
}

function parseApproval(input: unknown, index: number) {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) =>
        key !== 'current' && !APPROVAL_FIELDS.some((field) => field === key),
    )
  )
    throw new CommunityApprovalError(
      `invalid fields in approval ${index.toString()}`,
    );
  const { file, providerKey, version, sha256, origin, current } = input;
  if (
    (current !== undefined && typeof current !== 'boolean') ||
    typeof file !== 'string' ||
    file.length > COMMUNITY_MANIFEST_LIMITS.stringCharacters ||
    typeof providerKey !== 'string' ||
    providerKey.length > NODE_IDENTITY_KEY_MAX_CHARACTERS ||
    !providerKey.startsWith('community.') ||
    !CONNECTION_PROVIDER_KEY_PATTERN.test(providerKey) ||
    typeof version !== 'string' ||
    version.length > COMMUNITY_MANIFEST_LIMITS.versionCharacters ||
    typeof sha256 !== 'string' ||
    !SHA256_HEX_PATTERN.test(sha256) ||
    typeof origin !== 'string' ||
    origin.length > COMMUNITY_MANIFEST_LIMITS.stringCharacters ||
    !isCommunityOrigin(origin)
  )
    throw new CommunityApprovalError(
      `invalid value in approval ${index.toString()}`,
    );
  return { file, providerKey, version, sha256, origin, current };
}
