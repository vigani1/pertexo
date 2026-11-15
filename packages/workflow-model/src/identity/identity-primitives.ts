export const AUTHENTICATION_PROVIDERS = [
  'google',
  'microsoft',
  'github',
  'apple',
] as const;
import { z } from 'zod';
import { UUID_PATTERN } from '../values/identifiers.js';

export const FEDERATION_LIMITS = Object.freeze({
  workspaces: 10,
  domains: 20,
  providers: 10,
  secretBytes: 8192,
});

export const ACCOUNT_SIGN_IN_METHOD_LIMIT = 16;

/** How recent a sign-in must be for a sensitive account or workspace command. */
export const FRESH_SIGN_IN_WINDOW_MILLIS = 5 * 60_000;

/** The longest name a person shows: at sign-up, in their profile and to their workspaces. */
export const DISPLAY_NAME_MAX_CHARACTERS = 256;

/** How long a workspace invitation's link works after it's sent. */
export const WORKSPACE_INVITATION_VALIDITY_DAYS = 7;

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
