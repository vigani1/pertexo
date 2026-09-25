import {
  authenticationCapabilitiesResponseSchema,
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  userProfileUpdateResponseSchema,
  type AuthenticationCapabilitiesResponse,
  type UserProfileResponse,
  type UserProfileUpdateResponse,
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

/** Changes the signed-in person's name at the revision the edit started from. */
export function updateCurrentUserProfile(
  apiClient: ApiClient,
  attempt: Readonly<{
    displayName: string;
    expectedRevision: number;
    idempotencyKey: string;
  }>,
): Promise<UserProfileUpdateResponse> {
  return apiClient.request({
    path: '/v1/users/me',
    method: 'PATCH',
    body: userProfileUpdateRequestSchema.parse({
      displayName: attempt.displayName,
      expectedRevision: attempt.expectedRevision,
    }),
    headers: { 'Idempotency-Key': attempt.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => userProfileUpdateResponseSchema.parse(value),
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
