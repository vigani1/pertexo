import { describe, expect, it } from 'vitest';
import { samlServiceProviderUrls } from '../../../src/schemas/identity/federation/settings.js';
import { SamlHttpsOriginRequiredError } from '../../../src/schemas/identity/federation/federation.errors.js';

const organizationId = '0190a7e2-0000-7000-8000-000000000001';

describe('SAML service-provider URLs', () => {
  it('refuses an app address that is not HTTPS with its named error', () => {
    expect(() =>
      samlServiceProviderUrls('http://app.example.test', organizationId),
    ).toThrow(SamlHttpsOriginRequiredError);
  });

  it('builds the entity id under an HTTPS app address', () => {
    expect(
      samlServiceProviderUrls('https://app.example.test', organizationId)
        .entityId,
    ).toBe(
      `https://app.example.test/v1/auth/federation/saml/organizations/${organizationId}`,
    );
  });
});
