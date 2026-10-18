import { FederationManagementService } from '../../src/authentication/federation/management/service.js';
/** Unrelated API tests still construct the real module; federation storage is deliberately unavailable. */
export function stubFederationService(): FederationManagementService {
  const unused = () =>
    Promise.reject(
      new Error('Federation storage was not expected in this test'),
    );
  return new FederationManagementService(
    {
      close: () => Promise.resolve(),
      settings: unused,
      domainChallenge: unused,
      checkStoredSecrets: () => Promise.resolve(),
      verificationResult: unused,
      createOrganization: unused,
      linkWorkspace: unused,
      createDomain: unused,
      renewDomainChallenge: unused,
      verifyDomain: unused,
      removeDomain: unused,
      createOidcProvider: unused,
      updateOidcProvider: unused,
      removeOidcProvider: unused,
      configureEnforcement: unused,
    },
    undefined,
    'test-only-sign-in-secret-with-at-least-thirty-two-characters',
  );
}
