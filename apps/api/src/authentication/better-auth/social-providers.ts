import type { BetterAuthOptions } from 'better-auth';
import { authenticationProviderSchema } from '@pertexo/contracts';
import { canonicalEmail } from '@pertexo/workflow-model';
import { z } from 'zod';
import { verifyProviderIdToken } from 'better-auth/oauth2';

import type {
  SocialProviderGateway,
  SocialProviderName,
} from '../providers/contract.js';
import type { PertexoBetterAuth } from './options.js';

export function configuredSocialProviders(
  socialProviders: BetterAuthOptions['socialProviders'],
): SocialProviderName[] {
  return authenticationProviderSchema.options.filter(
    (name) => socialProviders?.[name] !== undefined,
  );
}

/**
 * Library providers verify the protocol proof; Pertexo finalizes identity
 * and session changes in its short database transaction.
 */
export function betterAuthSocialProviders(
  auth: PertexoBetterAuth,
  socialProviders: BetterAuthOptions['socialProviders'],
): SocialProviderGateway {
  const configuredProvider = async (providerId: string) =>
    (await auth.$context).socialProviders.find(
      (provider) => provider.id === providerId,
    );
  return {
    available: configuredSocialProviders(socialProviders),
    authorize: async (input) => {
      const provider = await configuredProvider(input.provider);
      if (provider === undefined) throw new Error('Provider unavailable');
      const url = await provider.createAuthorizationURL({
        state: input.state,
        codeVerifier: input.codeVerifier,
        idTokenNonce: input.nonce,
        redirectURI: input.redirectUri,
      });
      // The profile mapper and authorization-URL factory are separate SDK APIs.
      // Bind every OIDC token to this server-owned journey nonce on the wire.
      if (provider.idToken !== undefined)
        url.searchParams.set('nonce', input.nonce);
      return url.toString();
    },
    verify: async (input) => {
      const provider = await configuredProvider(input.provider);
      if (provider === undefined) return undefined;
      const expectedIssuer =
        provider.issuer ??
        (provider.idToken !== undefined && 'issuer' in provider.idToken
          ? provider.idToken.issuer
          : undefined);
      if (unexpectedIssuer(input.issuer, expectedIssuer)) return undefined;
      const tokens = await provider.validateAuthorizationCode({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectURI: input.redirectUri,
      });
      if (tokens === null) return undefined;
      const invalidIdentityToken =
        provider.idToken !== undefined &&
        (tokens.idToken === undefined ||
          tokens.idToken.length > 16_384 ||
          !(await verifyProviderIdToken(
            provider,
            tokens.idToken,
            input.nonce,
          )));
      if (invalidIdentityToken) return undefined;
      const profile = await provider.getUserInfo({
        ...tokens,
        expectedIdTokenNonce: input.nonce,
      });
      if (profile?.user === undefined) return undefined;
      const accountId = accountSubject(
        await provider.accountSubject({ tokens, profile: profile.data }),
      );
      if (accountId === undefined) return undefined;
      const email = z
        .string()
        .transform(canonicalEmail)
        .pipe(z.email().max(320))
        .nullable()
        .safeParse(profile.user.email ?? null);
      if (!email.success) return undefined;
      return {
        accountId,
        email: email.data,
        emailVerified: profile.user.emailVerified,
        ...(profile.user.name === undefined
          ? {}
          : {
              displayName:
                profile.user.name.slice(0, 256).trim() || 'Pertexo member',
            }),
      };
    },
  };
}

function accountSubject(subject: unknown): string | undefined {
  const invalidProviderSubject =
    (typeof subject !== 'string' && typeof subject !== 'number') ||
    String(subject).trim().length === 0 ||
    String(subject).length > 512 ||
    (typeof subject === 'number' && !Number.isSafeInteger(subject));
  if (invalidProviderSubject) return undefined;
  return String(subject);
}

function unexpectedIssuer(
  actual: string | null,
  expected: string | readonly string[] | undefined,
): boolean {
  const mismatched =
    actual !== null &&
    expected !== undefined &&
    !(typeof expected === 'string'
      ? actual === expected
      : expected.includes(actual));
  return mismatched;
}
