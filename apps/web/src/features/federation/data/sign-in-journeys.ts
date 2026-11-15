import type { ApiClient } from '@/lib/api/client';
import type { FederationProtocol } from '@pertexo/contracts';
import {
  discoverOrganizationSignIn,
  startOrganizationProviderTest,
  startOrganizationSignIn,
} from './sign-in.api';
import type { FederationScope } from './federation-settings.api';

// Organization sign-in, from finding a domain's providers to leaving for one;
// each step answers with what the page shows next or where it navigates.

/** The sign-in providers a verified domain offers. */
export function discoverDomainSignIn(
  apiClient: ApiClient,
  domain: string,
  signal: AbortSignal,
) {
  return discoverOrganizationSignIn(apiClient, domain, signal);
}

/** Starts signing in with a provider; resolves to the provider's address. */
export function beginOrganizationSignIn(
  apiClient: ApiClient,
  input: Readonly<{
    providerId: string;
    domain: string;
    protocol: FederationProtocol;
    returnTo?: string | undefined;
  }>,
  signal: AbortSignal,
) {
  return startOrganizationSignIn(
    apiClient,
    {
      providerId: input.providerId,
      domain: input.domain,
      ...(input.returnTo === undefined ? {} : { returnPath: input.returnTo }),
    },
    signal,
    input.protocol,
  );
}

/** Starts an owner's test sign-in through one provider and domain. */
export function beginProviderTest(
  scope: FederationScope,
  provider: Readonly<{ id: string; kind: FederationProtocol }>,
  domainId: string,
  signal: AbortSignal,
) {
  return startOrganizationProviderTest(
    scope.apiClient,
    { workspaceId: scope.workspaceId, providerId: provider.id, domainId },
    signal,
    provider.kind,
  );
}
