import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../../support/better-auth/real-api.support.js';
import { useSamlApi } from './api.fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'why a SAML proof was refused, through the real API',
  () => {
    const api = useSamlApi('saml_failure_reason');
    it('tells the owner running a test which check refused it', async () => {
      const fixture = await api.setup(),
        journey = await api.start(fixture, true);
      const { location } = (
        await api.finish(fixture, journey, { responseIssuer: 'urn:wrong:idp' })
      ).headers;
      const landing = new URL(String(location));
      expect(landing.searchParams.get('ssoTest')).toBe('failed');
      expect(landing.searchParams.get('ssoReason')).toBe('saml_issuer');
    });
    it('keeps a sign-in generic, so the reason can’t be probed', async () => {
      const fixture = await api.setup(),
        journey = await api.start(fixture);
      const { location } = (
        await api.finish(fixture, journey, { responseIssuer: 'urn:wrong:idp' })
      ).headers;
      const landing = new URL(String(location));
      expect(landing.searchParams.get('ssoError')).toBe('true');
      expect(landing.searchParams.has('ssoReason')).toBe(false);
    });
  },
);
