import { z } from 'zod';
import { UUID_PATTERN } from '../values/identifiers.js';

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
