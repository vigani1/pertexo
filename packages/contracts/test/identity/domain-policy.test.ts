import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PROMOTION_LIMITS } from '../../src/schemas/workflows/promotions/settings.js';
import { COLLABORATION_LIMITS } from '../../src/schemas/workflows/collaboration/comments.js';
import { FEDERATION_LIMITS } from '../../src/schemas/identity/federation/settings.js';
import {
  AUDIT_RETENTION_MIN_DAYS,
  AUDIT_RETENTION_MAX_DAYS,
  auditRetentionSchema,
} from '../../src/schemas/identity/governance.js';
import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '../../src/schemas/identity/authentication.js';
import {
  API_TOKEN_SCOPES,
  API_TOKEN_ACTIVE_LIMIT,
  apiTokenCredentialSchema,
} from '../../src/schemas/identity/api-tokens.js';

it('keeps authoring and identity policy limits unchanged at the transport boundary', () => {
  expect(PROMOTION_LIMITS).toEqual({
    workflows: 20,
    graphBytes: 2097152,
    responseBytes: 4194304,
    requirements: 1000,
    page: 50,
  });
  expect(COLLABORATION_LIMITS).toEqual({
    body: 8000,
    mentions: 20,
    page: 20,
    presence: 100,
    tabs: 10,
    leaseSeconds: 45,
    heartbeatMs: 15000,
    pollMs: 10000,
  });
  expect(FEDERATION_LIMITS).toEqual({
    workspaces: 10,
    domains: 20,
    providers: 10,
    secretBytes: 8192,
  });
  expect(AUDIT_RETENTION_MIN_DAYS).toBe(30);
  expect(auditRetentionSchema.safeParse(29).success).toBe(false);
  expect(auditRetentionSchema.parse(30)).toBe(30);
  expect(ACCOUNT_SIGN_IN_METHOD_LIMIT).toBe(16);
  expect(API_TOKEN_ACTIVE_LIMIT).toBe(10);
  expect(API_TOKEN_SCOPES).toEqual([
    'workflow:read',
    'workflow:create',
    'workflow:publish',
    'run:read',
    'run:start',
    'run:cancel',
    'connection:read',
  ]);
});

it('retains canonical token UUID routing and base64url padding bits', () => {
  const prefix =
    'ptx_1.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.';
  const credential = prefix + 'A'.repeat(43);
  expect(apiTokenCredentialSchema.parse(credential)).toBe(credential);
  expect(
    apiTokenCredentialSchema.safeParse(prefix + 'A'.repeat(42) + 'B').success,
  ).toBe(false);
  expect(apiTokenCredentialSchema.safeParse(credential + '=').success).toBe(
    false,
  );
});

it('keeps the audit retention maximum aligned with the database constraint', () => {
  expect(AUDIT_RETENTION_MAX_DAYS).toBe(2555);
  expect(auditRetentionSchema.safeParse(2556).success).toBe(false);
  const schema = readFileSync(
    new URL('../../../database/src/schema/foundation.ts', import.meta.url),
    'utf8',
  );
  expect(schema).toContain(
    `audit_retention_days between 30 and ${String(AUDIT_RETENTION_MAX_DAYS)}`,
  );
});
