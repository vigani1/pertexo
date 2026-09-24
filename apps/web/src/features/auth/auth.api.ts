import {
  authenticationCapabilitiesResponseSchema,
  oidcStartResponseSchema,
  userProfileResponseSchema,
  type AuthenticationCapabilitiesResponse,
  type UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';

function decodeOidcStart(value: unknown) {
  const transaction = oidcStartResponseSchema.parse(value);
  const authorizationUrl = new URL(transaction.authorizationUrl);
  const loopbackHttp =
    authorizationUrl.protocol === 'http:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(authorizationUrl.hostname);
  if (authorizationUrl.protocol !== 'https:' && !loopbackHttp)
    throw new TypeError('OIDC authorization URL must use HTTPS');
  return transaction;
}

export function startOidcLogin(apiClient: ApiClient, signal?: AbortSignal) {
  return apiClient.request({
    path: '/v1/auth/oidc/start',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: decodeOidcStart,
    },
  });
}

export function getAuthenticationCapabilities(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<AuthenticationCapabilitiesResponse> {
  return apiClient.request({
    path: '/v1/auth/capabilities',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => authenticationCapabilitiesResponseSchema.parse(value),
    },
  });
}

export function getCurrentUser(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<UserProfileResponse> {
  return apiClient.request({
    path: '/v1/users/me',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => userProfileResponseSchema.parse(value),
    },
  });
}

export function logoutSession(apiClient: ApiClient): Promise<void> {
  return apiClient.request({
    path: '/v1/auth/logout',
    method: 'POST',
    response: { kind: 'empty' },
  });
}
