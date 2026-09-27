import { OIDC_BROWSER_BINDING_COOKIE_NAME } from './guards.js';
import type { SessionCookiePolicy } from './ports.js';

const OIDC_CALLBACK_COOKIE_PATH = '/v1/auth/oidc/callback';

/** Cross-site provider callback policy, distinct from session/invitation cookies. */
export function serializeOidcBindingCookie(
  value: string,
  expiresAt: Date,
  maxAgeSeconds: number,
  policy: SessionCookiePolicy,
): string {
  return [
    `${OIDC_BROWSER_BINDING_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${OIDC_CALLBACK_COOKIE_PATH}`,
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

export function clearOidcBindingCookie(policy: SessionCookiePolicy): string {
  return [
    `${OIDC_BROWSER_BINDING_COOKIE_NAME}=`,
    `Path=${OIDC_CALLBACK_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    'SameSite=Lax',
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}
