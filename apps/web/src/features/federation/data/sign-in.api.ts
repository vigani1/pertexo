import {
  federationDiscoverySchema,
  authorizationStartedSchema,
  type FederationSignInStart,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
export function discoverOrganizationSignIn(
  apiClient: ApiClient,
  domain: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: `/v1/auth/federation/discover?${new URLSearchParams({ domain })}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => federationDiscoverySchema.parse(value),
    },
  });
}
function decodeAuthorization(value: unknown): string {
  const response = authorizationStartedSchema.parse(value),
    url = new URL(response.authorizationUrl);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new Error('Organization sign-in returned an invalid destination');
  return url.toString();
}
export function startOrganizationSignIn(
  apiClient: ApiClient,
  input: FederationSignInStart,
  signal: AbortSignal,
): Promise<string> {
  return apiClient.request({
    path: '/v1/auth/federation/oidc/start',
    method: 'POST',
    body: input,
    csrf: 'external',
    signal,
    response: { kind: 'json', decode: decodeAuthorization },
  });
}
export function startOrganizationProviderTest(
  apiClient: ApiClient,
  input: Readonly<{
    workspaceId: string;
    providerId: string;
    domainId: string;
  }>,
  signal: AbortSignal,
): Promise<string> {
  return apiClient.request({
    path: '/v1/auth/federation/oidc/test',
    method: 'POST',
    body: input,
    signal,
    response: { kind: 'json', decode: decodeAuthorization },
  });
}
