import { describe, expect, it } from 'vitest';
import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListQuerySchema,
  apiTokenMetadataSchema,
} from '../../src/schemas/identity/api-tokens.js';

const metadata = {
  id: '0194a800-0000-7000-8000-000000000001',
  workspaceId: '0194a800-0000-7000-8000-000000000002',
  name: 'Build runner',
  scopes: ['run:read'],
  createdAt: '2026-10-14T00:00:00.000Z',
  expiresAt: '2026-10-15T00:00:00.000Z',
  lastUsedAt: null,
};
const revokedAt = '2026-10-14T12:00:00.000Z';

describe('API token contracts', () => {
  it('normalizes names and scope order with a finite default lifetime', () => {
    expect(
      apiTokenCreateRequestSchema.parse({
        name: '  Build runner  ',
        scopes: ['workflow:read', 'run:start'],
      }),
    ).toEqual({
      name: 'Build runner',
      scopes: ['run:start', 'workflow:read'],
      expiresInDays: 30,
    });
  });
  it.each([
    { name: 'x', scopes: ['workspace:manage'] },
    { name: 'x', scopes: ['run:start', 'run:start'] },
    { name: 'x', scopes: [] },
    { name: 'x', scopes: ['run:read'], expiresInDays: 0 },
    { name: 'x', scopes: ['run:read'], expiresInDays: 366 },
    { name: 'x', scopes: ['run:read'], ownerUserId: 'impersonate' },
  ])('rejects unusable or elevated input', (value) => {
    expect(apiTokenCreateRequestSchema.safeParse(value).success).toBe(false);
  });
  it('bounds metadata pagination', () => {
    expect(apiTokenListQuerySchema.parse({}).limit).toBe(25);
    expect(apiTokenListQuerySchema.safeParse({ limit: 51 }).success).toBe(
      false,
    );
  });
  it('does not allow a secret on a creation replay', () => {
    const token = {
      id: '0194a800-0000-7000-8000-000000000001',
      workspaceId: '0194a800-0000-7000-8000-000000000002',
      name: 'Build runner',
      scopes: ['run:read'],
      status: 'active',
      createdAt: '2026-10-14T00:00:00.000Z',
      expiresAt: '2026-10-15T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
    };
    expect(
      apiTokenCreateResponseSchema.safeParse({ token, replayed: true }).success,
    ).toBe(true);
    expect(
      apiTokenCreateResponseSchema.safeParse({
        token,
        replayed: true,
        secret: 'sensitive',
      }).success,
    ).toBe(false);
    expect(
      apiTokenCreateResponseSchema.safeParse({ token, replayed: false })
        .success,
    ).toBe(false);
  });
  // A token has a revocation time exactly when it is revoked.
  it.each([
    ['revoked', revokedAt],
    ['active', null],
    ['expired', null],
    ['membership_changed', null],
  ])('accepts %s token metadata with revokedAt %s', (status, at) => {
    expect(
      apiTokenMetadataSchema.safeParse({ ...metadata, status, revokedAt: at })
        .success,
    ).toBe(true);
  });

  it.each([
    ['revoked', null],
    ['active', revokedAt],
    ['expired', revokedAt],
    ['membership_changed', revokedAt],
  ])('refuses %s token metadata with revokedAt %s', (status, at) => {
    expect(
      apiTokenMetadataSchema.safeParse({ ...metadata, status, revokedAt: at })
        .success,
    ).toBe(false);
  });
});
