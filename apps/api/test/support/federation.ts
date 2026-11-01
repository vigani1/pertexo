import type { DirectoryStore } from '@pertexo/core/identity';
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
      createProvider: unused,
      updateProvider: unused,
      removeProvider: unused,
      configureEnforcement: unused,
    },
    undefined,
    {
      secret: 'test-only-sign-in-secret-with-at-least-thirty-two-characters',
      publicOrigin: 'https://pertexo.test',
      secureCookies: true,
    },
  );
}

export function stubDirectoryStore(): DirectoryStore {
  const unused = () =>
    Promise.reject(
      new Error('Directory storage was not expected in this test'),
    );
  return {
    close: () => Promise.resolve(),
    authenticate: unused,
    user: unused,
    group: unused,
    users: unused,
    groups: unused,
    createUser: unused,
    changeUser: unused,
    deleteUser: unused,
    createGroup: unused,
    changeGroup: unused,
    deleteGroup: unused,
    adoption: unused,
    settings: unused,
    people: unused,
    createCredential: unused,
    revokeCredential: unused,
    replaceMappings: unused,
    adopt: unused,
    unlink: unused,
  };
}
