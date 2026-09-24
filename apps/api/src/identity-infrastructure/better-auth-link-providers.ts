import type { BetterAuthOptions } from 'better-auth';

import type { LinkProviderGateway } from './account-linking.js';
import type { PertexoBetterAuth } from './better-auth-options.js';

const LINKABLE_PROVIDERS = ['google', 'github', 'microsoft', 'apple'] as const;

/** Providers that can take part in linking are exactly the configured ones. */
export function configuredLinkProviders(
  socialProviders: BetterAuthOptions['socialProviders'],
): LinkProviderGateway['available'] {
  return LINKABLE_PROVIDERS.filter(
    (name) => socialProviders?.[name] !== undefined,
  );
}

/**
 * Link and migration proofs run Better Auth's configured OAuth providers with
 * Pertexo-derived state, PKCE and nonce. Verification fails closed on an
 * issuer mismatch, a rejected code or an unusable account subject.
 */
export function betterAuthLinkProviders(
  auth: PertexoBetterAuth,
  socialProviders: BetterAuthOptions['socialProviders'],
): LinkProviderGateway {
  const configuredProvider = async (providerId: string) =>
    (await auth.$context).socialProviders.find(
      (provider) => provider.id === providerId,
    );
  return {
    available: configuredLinkProviders(socialProviders),
    authorize: async (input) => {
      const provider = await configuredProvider(input.provider);
      if (provider === undefined) throw new Error('Provider unavailable');
      const url = await provider.createAuthorizationURL({
        state: input.state,
        codeVerifier: input.codeVerifier,
        idTokenNonce: input.nonce,
        redirectURI: input.redirectUri,
      });
      return url.toString();
    },
    verify: async (input) => {
      const provider = await configuredProvider(input.provider);
      if (provider === undefined) return undefined;
      if (
        input.issuer !== null &&
        provider.issuer !== undefined &&
        input.issuer !== provider.issuer
      )
        return undefined;
      const tokens = await provider.validateAuthorizationCode({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectURI: input.redirectUri,
      });
      if (tokens === null) return undefined;
      const profile = await provider.getUserInfo({
        ...tokens,
        expectedIdTokenNonce: input.nonce,
      });
      if (profile?.user === undefined) return undefined;
      const accountId = accountSubject(
        await provider.accountSubject({ tokens, profile: profile.data }),
      );
      if (accountId === undefined) return undefined;
      return {
        accountId,
        email: profile.user.email ?? null,
        emailVerified: profile.user.emailVerified,
      };
    },
  };
}

function accountSubject(subject: unknown): string | undefined {
  if (
    (typeof subject !== 'string' && typeof subject !== 'number') ||
    String(subject).trim().length === 0 ||
    (typeof subject === 'number' && !Number.isFinite(subject))
  )
    return undefined;
  return String(subject);
}
