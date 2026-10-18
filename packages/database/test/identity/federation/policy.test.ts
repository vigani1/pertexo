import { describe, expect, it } from 'vitest';
import {
  authenticationAllowed,
  type AuthenticationPolicy,
} from '../../../src/identity/federation/sessions/policy.js';
const policy: AuthenticationPolicy = {
  active: true,
  enforcedOrganizationId: 'organization-a',
  verifiedOrganizationId: 'organization-a',
  recoveryOwner: false,
};
const proof = {
  method: 'organization',
  providerId: 'provider-a',
  providerRevision: 3,
} as const;
const provider = {
  organizationId: 'organization-a',
  enabled: true,
  revision: 3,
  directoryAllowed: true,
};
describe('one organization session rule', () => {
  it('allows ordinary sign-in only when the domain does not require SSO', () => {
    expect(
      authenticationAllowed(
        { ...policy, enforcedOrganizationId: null },
        { method: 'credential' },
      ),
    ).toBe(true);
    expect(
      authenticationAllowed(
        { ...policy, enforcedOrganizationId: null },
        { method: 'social' },
      ),
    ).toBe(true);
    expect(authenticationAllowed(policy, { method: 'credential' })).toBe(false);
    expect(authenticationAllowed(policy, { method: 'social' })).toBe(false);
  });
  it('allows only a current enabled provider from the exact verified organization', () => {
    expect(authenticationAllowed(policy, proof, provider)).toBe(true);
    expect(authenticationAllowed(policy, proof)).toBe(false);
    expect(
      authenticationAllowed(policy, proof, {
        ...provider,
        directoryAllowed: false,
      }),
    ).toBe(false);
    expect(
      authenticationAllowed(policy, proof, { ...provider, revision: 4 }),
    ).toBe(false);
    expect(
      authenticationAllowed(policy, proof, { ...provider, enabled: false }),
    ).toBe(false);
    expect(
      authenticationAllowed(policy, proof, {
        ...provider,
        organizationId: 'organization-b',
      }),
    ).toBe(false);
    expect(
      authenticationAllowed(
        { ...policy, verifiedOrganizationId: null },
        proof,
        provider,
      ),
    ).toBe(false);
  });
  it('restricts recovery to a proven control owner using a password', () => {
    expect(
      authenticationAllowed(
        { ...policy, recoveryOwner: true },
        { method: 'credential' },
      ),
    ).toBe(true);
    expect(
      authenticationAllowed(
        { ...policy, recoveryOwner: true },
        { method: 'social' },
      ),
    ).toBe(false);
  });
  it('never gives inactive users a session, including recovery owners', () => {
    expect(
      authenticationAllowed(
        { ...policy, active: false, recoveryOwner: true },
        { method: 'credential' },
      ),
    ).toBe(false);
    expect(
      authenticationAllowed({ ...policy, active: false }, proof, provider),
    ).toBe(false);
  });
});
