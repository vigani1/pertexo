export const AUTHENTICATION_PROVIDERS = [
  'google',
  'microsoft',
  'github',
  'apple',
] as const;
import { z } from 'zod';
import { UUID_PATTERN } from '../values/identifiers.js';

/**
 * The one form an email address is compared and stored in. Equal under this
 * rule means the same person, for invitations, sign-in and account linking.
 */
export function canonicalEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

export const FEDERATION_LIMITS = Object.freeze({
  workspaces: 10,
  domains: 20,
  providers: 10,
  secretBytes: 8192,
});

export const ACCOUNT_SIGN_IN_METHOD_LIMIT = 16;

export const API_TOKEN_SCOPES = [
  'workflow:read',
  'workflow:create',
  'workflow:publish',
  'run:read',
  'run:start',
  'run:cancel',
  'connection:read',
] as const;

export const API_TOKEN_DEFAULT_LIFETIME_DAYS = 30;

export const API_TOKEN_MAX_LIFETIME_DAYS = 365;

export const API_TOKEN_ACTIVE_LIMIT = 10;

const uuidBody = UUID_PATTERN.source.slice(1, -1);

export const apiTokenCredentialSchema = z
  .string()
  .regex(
    new RegExp(
      `^ptx_1\\.${uuidBody}\\.${uuidBody}\\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`,
      'u',
    ),
  );

export const DIRECTORY_LIMITS = Object.freeze({
  credentials: 5,
  users: 5000,
  groups: 200,
  membersPerGroup: 500,
  mappingsPerWorkspace: 200,
  patchOperations: 100,
  page: 100,
  requestBytes: 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  profileBytes: 16 * 1024,
  jsonDepth: 16,
  jsonMembers: 4096,
  filterCharacters: 1024,
  filterDepth: 16,
  filterNodes: 256,
  emailsPerUser: 5,
});
