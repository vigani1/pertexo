import {
  accountSecurityLinkStartResponseSchema,
  type AccountSecurityLinkStartRequest,
  accountSecurityPasswordChangeResponseSchema,
  accountSecurityPasswordSetupResponseSchema,
  accountSecurityResponseSchema,
  accountSecurityMethodUnlinkResponseSchema,
  accountSecurityRevokeOthersResponseSchema,
  accountSecuritySessionRevokeResponseSchema,
  accountSecuritySessionsResponseSchema,
  type AccountSecuritySessionsResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';

export function listAccountSecuritySessions(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<AccountSecuritySessionsResponse> {
  return apiClient.request({
    path: '/v1/auth/account-security/sessions',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => accountSecuritySessionsResponseSchema.parse(value),
    },
  });
}

export function getAccountSecurity(apiClient: ApiClient, signal?: AbortSignal) {
  return apiClient.request({
    path: '/v1/auth/account-security',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => accountSecurityResponseSchema.parse(value),
    },
  });
}

export function changeAccountPassword(
  apiClient: ApiClient,
  input: Readonly<{ currentPassword: string; newPassword: string }>,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/auth/account-security/password/change',
    method: 'POST',
    body: input,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) =>
        accountSecurityPasswordChangeResponseSchema.parse(value),
    },
  });
}

export function setupAccountPassword(
  apiClient: ApiClient,
  newPassword: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/auth/account-security/password/setup',
    method: 'POST',
    body: { newPassword },
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) =>
        accountSecurityPasswordSetupResponseSchema.parse(value),
    },
  });
}

export function unlinkAccountSecurityMethod(
  apiClient: ApiClient,
  methodId: string,
) {
  return apiClient.request({
    path: '/v1/auth/account-security/methods/unlink',
    method: 'POST',
    body: { methodId },
    response: {
      kind: 'json',
      decode: (value) => accountSecurityMethodUnlinkResponseSchema.parse(value),
    },
  });
}

export async function startAccountLink(
  apiClient: ApiClient,
  input: AccountSecurityLinkStartRequest,
  signal?: AbortSignal,
): Promise<string> {
  const result = await apiClient.request({
    path: '/v1/auth/account-security/methods/link/start',
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
    body: input,
    response: {
      kind: 'json',
      decode: (value) => accountSecurityLinkStartResponseSchema.parse(value),
    },
  });
  const parsed = new URL(result.authorizationUrl);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')
    throw new TypeError('The provider URL was rejected.');
  return parsed.toString();
}

export function requestAccountEmailChange(
  apiClient: ApiClient,
  newEmail: string,
) {
  return apiClient.request({
    path: '/v1/auth/change-email',
    method: 'POST',
    body: { newEmail, callbackURL: '/login?emailChanged=true' },
    response: {
      kind: 'json',
      decode: (value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Reflect.get(value, 'status') !== true
        )
          throw new TypeError('The email-change response was invalid.');
        return { requested: true as const };
      },
    },
  });
}

export function revokeAccountSecuritySession(
  apiClient: ApiClient,
  sessionId: string,
): Promise<{ revoked: boolean }> {
  return apiClient.request({
    path: '/v1/auth/account-security/sessions/revoke',
    method: 'POST',
    body: { sessionId },
    response: {
      kind: 'json',
      decode: (value) =>
        accountSecuritySessionRevokeResponseSchema.parse(value),
    },
  });
}

export function revokeOtherAccountSecuritySessions(
  apiClient: ApiClient,
): Promise<{ revokedCount: number }> {
  return apiClient.request({
    path: '/v1/auth/account-security/sessions/revoke-others',
    method: 'POST',
    body: {},
    response: {
      kind: 'json',
      decode: (value) => accountSecurityRevokeOthersResponseSchema.parse(value),
    },
  });
}
