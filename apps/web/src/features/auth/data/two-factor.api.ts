import type { ApiClient } from '@/lib/api/client';

function decodeCodes(value: unknown): { backupCodes: string[] } {
  const codes: unknown =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'backupCodes')
      : undefined;
  if (
    !Array.isArray(codes) ||
    codes.length !== 10 ||
    !codes.every(
      (code: unknown): code is string =>
        typeof code === 'string' && code.length > 0 && code.length <= 128,
    )
  )
    throw new TypeError('The recovery-code response was invalid.');
  return { backupCodes: codes };
}
function decodeEnrollment(value: unknown) {
  const { backupCodes } = decodeCodes(value);
  const uri: unknown =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'totpURI')
      : undefined;
  if (
    typeof uri !== 'string' ||
    new TextEncoder().encode(uri).byteLength > 2048
  )
    throw new TypeError('The authenticator response was invalid.');
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError('The authenticator response was invalid.');
  }
  if (
    parsed.protocol !== 'otpauth:' ||
    parsed.hostname !== 'totp' ||
    !parsed.searchParams.get('secret')
  )
    throw new TypeError('The authenticator response was invalid.');
  return { backupCodes, totpURI: uri };
}
function decodeDisabled(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Reflect.get(value, 'status') !== true
  )
    throw new TypeError('The authentication response was invalid.');
}
function decodeVerification(value: unknown): void {
  const user: unknown =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'user')
      : undefined;
  if (
    typeof user !== 'object' ||
    user === null ||
    typeof Reflect.get(user, 'id') !== 'string'
  )
    throw new TypeError('The authentication response was invalid.');
}

export function enableTwoFactor(
  apiClient: ApiClient,
  password: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/auth/two-factor/enable',
    method: 'POST',
    body: { password },
    signal,
    response: { kind: 'json', decode: (value) => decodeEnrollment(value) },
  });
}
export function regenerateRecoveryCodes(
  apiClient: ApiClient,
  password: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/auth/two-factor/generate-backup-codes',
    method: 'POST',
    body: { password },
    signal,
    response: { kind: 'json', decode: (value) => decodeCodes(value) },
  });
}
export function disableTwoFactor(
  apiClient: ApiClient,
  password: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/auth/two-factor/disable',
    method: 'POST',
    body: { password },
    signal,
    response: {
      kind: 'json',
      decode: (value) => {
        decodeDisabled(value);
      },
    },
  });
}
export function verifyTwoFactor(
  apiClient: ApiClient,
  input: Readonly<{
    code: string;
    method: 'totp' | 'recovery';
    purpose: 'sign-in' | 'enrollment';
  }>,
  signal: AbortSignal,
) {
  return apiClient.request({
    path:
      input.method === 'totp'
        ? '/v1/auth/two-factor/verify-totp'
        : '/v1/auth/two-factor/verify-backup-code',
    method: 'POST',
    csrf: input.purpose === 'sign-in' ? 'external' : 'session',
    body: { code: input.code },
    signal,
    response: {
      kind: 'json',
      decode: (value) => {
        decodeVerification(value);
      },
    },
  });
}
