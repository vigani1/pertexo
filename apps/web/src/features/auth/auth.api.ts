import {
  authenticationCapabilitiesResponseSchema,
  userProfileResponseSchema,
  type AuthenticationCapabilitiesResponse,
  type UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';

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
