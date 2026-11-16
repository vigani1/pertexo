import { readAccountProviderNames } from '@pertexo/core/identity';
import type { SocialProviderGateway } from '../social-provider.types.js';
import { TwoFactorUnavailableError } from './account-security.errors.js';
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import type { Pool } from 'pg';

export function createGetPertexoAccountSecurityEndpoint(
  pool: Pool,
  availableLinkProviders: SocialProviderGateway['available'],
) {
  return createAuthEndpoint(
    '/account-security',
    {
      method: 'GET',
      requireHeaders: true,
      use: [sessionMiddleware],
    },
    async (context) => {
      const enabled = context.context.session.user.twoFactorEnabled === true;
      let recoveryCodesRemaining: number | null = null;
      if (enabled) {
        const plugin = context.context.getPlugin('two-factor');
        if (plugin === null)
          throw new TwoFactorUnavailableError(
            'Two-factor plugin is not configured',
          );
        recoveryCodesRemaining = (
          await plugin.endpoints.viewBackupCodes({
            body: { userId: context.context.session.user.id },
            context: context.context,
          })
        ).backupCodes.length;
      }
      const accounts = await context.context.internalAdapter.findAccounts(
        context.context.session.user.id,
      );
      const names = await readAccountProviderNames(
        pool,
        accounts.map((account) => account.providerId),
      );
      return context.json({
        email: context.context.session.user.email,
        emailVerified: context.context.session.user.emailVerified,
        availableProviders: availableLinkProviders,
        twoFactor: { enabled, recoveryCodesRemaining },
        methods: accounts.map((account) => ({
          id: account.id,
          kind: accountMethodKind(account.providerId, names),
          ...(names.has(account.providerId)
            ? { label: names.get(account.providerId) }
            : {}),
          provider:
            account.providerId === 'credential' ? null : account.providerId,
        })),
      });
    },
  );
}

function accountMethodKind(
  providerId: string,
  names: ReadonlyMap<string, string>,
): 'password' | 'organization' | 'social' {
  if (providerId === 'credential') return 'password';
  return names.has(providerId) ? 'organization' : 'social';
}
