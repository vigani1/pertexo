import { describe, expect, it } from 'vitest';
import {
  federationDomainNameSchema,
  oidcProviderCreateSchema,
  federationWorkspaceLinkSchema,
  federationSettingsSchema,
} from '../../src/schemas/identity/federation/settings.js';
const provider = {
  kind: 'oidc',
  name: 'Example',
  issuer: 'https://idp.example.test/tenant',
  configuration: { clientId: 'client' },
  clientSecret: 'secret',
  expectedRevision: 1,
};
describe('organization federation boundaries', () => {
  it.each([
    ['EXAMPLE.COM.', 'example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    [' sub.example.test ', 'sub.example.test'],
  ])('normalizes exact DNS domain %s', (input, expected) => {
    expect(federationDomainNameSchema.parse(input)).toBe(expected);
  });
  it.each([
    'https://example.test',
    'example.test/path',
    'user@example.test',
    'example.test:443',
    '*.example.test',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'example%2Etest',
    'example.test?x=1',
    'bad..example',
    '-bad.example',
    'bad-.example',
    'a'.repeat(64) + '.test',
  ])('refuses an ambiguous or invalid DNS domain %s', (input) => {
    expect(federationDomainNameSchema.safeParse(input).success).toBe(false);
  });
  it('defaults JIT off and uses explicit scalar claim names', () => {
    expect(oidcProviderCreateSchema.parse(provider)).toMatchObject({
      enabled: false,
      configuration: {
        clientId: 'client',
        emailClaim: 'email',
        nameClaim: 'name',
        jitEnabled: false,
      },
    });
  });
  it.each([
    'http://example.test',
    'https://user:secret@example.test',
    'https://example.test?key=secret',
    'https://example.test#fragment',
  ])('requires a clean exact HTTPS issuer %s', (issuer) => {
    expect(
      oidcProviderCreateSchema.safeParse({ ...provider, issuer }).success,
    ).toBe(false);
  });
  it.each(['', 'h', 'https:', 'https:/', 'https://', '://bad'])(
    'rejects partial issuer input without throwing: %s',
    (issuer) => {
      expect(
        oidcProviderCreateSchema.safeParse({ ...provider, issuer }).success,
      ).toBe(false);
    },
  );
  it('bounds secrets in UTF-8 bytes and refuses silent extra fields', () => {
    expect(
      oidcProviderCreateSchema.safeParse({
        ...provider,
        clientSecret: 'é'.repeat(4096),
      }).success,
    ).toBe(true);
    expect(
      oidcProviderCreateSchema.safeParse({
        ...provider,
        clientSecret: 'é'.repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      oidcProviderCreateSchema.safeParse({ ...provider, role: 'owner' })
        .success,
    ).toBe(false);
    expect(
      oidcProviderCreateSchema.safeParse({
        ...provider,
        configuration: { clientId: 'client', rolesClaim: 'admin' },
      }).success,
    ).toBe(false);
  });
  it('never allows a directory default to grant ownership', () => {
    const request = {
      workspaceId: '0199a4a2-5c1e-7000-8000-000000000001',
      expectedRevision: 1,
    };
    expect(federationWorkspaceLinkSchema.parse(request).defaultRole).toBe(
      'viewer',
    );
    expect(
      federationWorkspaceLinkSchema.safeParse({
        ...request,
        defaultRole: 'owner',
      }).success,
    ).toBe(false);
  });
  it('refuses secrets in a safe settings projection', () => {
    expect(
      federationSettingsSchema.safeParse({
        configured: true,
        reason: null,
        canManage: true,
        organization: null,
        clientSecret: 'leaked',
      }).success,
    ).toBe(false);
  });
});
