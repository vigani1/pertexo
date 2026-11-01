import { twoFactor } from 'better-auth/plugins/two-factor';
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from 'better-auth/api';
import { isAuthenticationSessionAllowed } from '@pertexo/core/tenant-access';
import type { Pool } from 'pg';
import type { AuthenticationTransactions } from './transactions/context.js';
import { requireDoubleSubmitCsrf } from './csrf.js';

export const TWO_FACTOR_VERIFICATION_PATHS = [
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
] as const;
const managementPaths = new Set([
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
]);

export function isTwoFactorVerificationPath(path: string | undefined): boolean {
  return TWO_FACTOR_VERIFICATION_PATHS.some((candidate) => candidate === path);
}

export function authenticationChangedError(): APIError {
  return new APIError('CONFLICT', {
    code: 'AUTHENTICATION_CHANGED',
    message:
      'Sign-in settings changed. Try again using your current organization policy.',
  });
}

export function createTwoFactorPlugin() {
  return twoFactor({
    issuer: 'Pertexo',
    schema: {
      user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
      twoFactor: {
        modelName: 'auth_two_factors',
        fields: {
          userId: 'user_id',
          backupCodes: 'backup_codes',
          failedVerificationCount: 'failed_verification_count',
          lockedUntil: 'locked_until',
        },
      },
    },
  });
}

/** Native factor endpoints keep Pertexo's account-security policy. */
export function twoFactorRouteGuard(
  pool: Pool,
  transactions?: AuthenticationTransactions,
) {
  return {
    matcher: (context: { path?: string | undefined }) =>
      managementPaths.has(context.path ?? '') ||
      isTwoFactorVerificationPath(context.path),
    handler: createAuthMiddleware(async (context) => {
      const body: unknown = context.body;
      const trustDeviceRequested =
        typeof body === 'object' &&
        body !== null &&
        'trustDevice' in body &&
        body.trustDevice === true;
      if (trustDeviceRequested)
        throw new APIError('BAD_REQUEST', {
          code: 'TRUST_DEVICE_DISABLED',
          message:
            'An authenticator or recovery code is required at every password sign-in.',
        });
      const session = await getAuthoritativeSessionFromCtx(context);
      const management = managementPaths.has(context.path);
      if (session === null) {
        if (management) throw new APIError('UNAUTHORIZED');
        return;
      }
      if (
        !(await isAuthenticationSessionAllowed(
          transactions?.current()?.client ?? pool,
          session.session.id,
        ))
      )
        throw new APIError('UNAUTHORIZED');
      requireDoubleSubmitCsrf(context.headers);
      if (
        management &&
        Date.now() - session.session.createdAt.getTime() >=
          context.context.sessionConfig.freshAge * 1000
      )
        throw new APIError('FORBIDDEN', {
          code: 'SESSION_NOT_FRESH',
          message: 'Sign in again before changing two-factor sign-in.',
        });
    }),
  };
}
