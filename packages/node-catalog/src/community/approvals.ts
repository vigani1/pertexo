import path from 'node:path';
import {
  CONNECTION_PROVIDER_KEY_PATTERN,
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
} from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
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
type CommunityApproval = Readonly<
  Record<(typeof APPROVAL_FIELDS)[number], string>
>;
export type CommunityApprovalSet = Readonly<{
  root: string;
  approvals: readonly CommunityApproval[];
}>;

export function parseCommunityApprovalSet(
  root: string | undefined,
  json: string | undefined,
): CommunityApprovalSet | undefined {
  if (json === undefined) return undefined;
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
  if (parsed.length === 0) return undefined;
  if (root === undefined || !path.isAbsolute(root))
    throw new CommunityApprovalError(
      'COMMUNITY_INTEGRATION_ROOT must be an absolute path',
    );
  return Object.freeze({
    root: path.resolve(root),
    approvals: Object.freeze(parsed.map(parseApproval)),
  });
}

function parseApproval(input: unknown, index: number): CommunityApproval {
  if (!isRecord(input) || Object.keys(input).length !== APPROVAL_FIELDS.length)
    throw new CommunityApprovalError(
      `invalid fields in approval ${index.toString()}`,
    );
  const { file, providerKey, version, sha256, origin } = input;
  if (
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
  return Object.freeze({ file, providerKey, version, sha256, origin });
}
