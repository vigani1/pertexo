import { z } from 'zod';

import {
  constantTimeStringEqual,
  digestBase64Url,
  digestSha256Hex,
  encodeBase64Url,
  nodeIdentityCrypto,
} from './crypto.js';
import { IdentityError, isIdentityError } from './errors.js';
import type {
  IdentityClock,
  InternalIdentityMapperPort,
  OidcAuthorizationRequest,
  OidcLoginTransactionStore,
  OidcProviderPort,
} from './ports.js';
import type {
  ExternalIdentity,
  OidcCallbackInput,
  OidcConfiguration,
  VerifiedOidcProfile,
} from './types.js';
import {
  internalIdentitySchema,
  oidcCallbackInputSchema,
  oidcConfigurationSchema,
} from './types.js';
import type { IdentityCrypto } from './crypto.js';

const tokenResponseSchema = z.object({
  issuer: z.string().max(2_048),
  subject: z.string().max(512),
  audience: z.union([
    z.string().max(512),
    z.array(z.string().max(512)).min(1).max(32),
  ]),
  nonce: z.string().max(512),
  email: z.string().trim().pipe(z.email().max(320)).optional(),
  displayName: z.string().trim().min(1).max(256).optional(),
  emailVerified: z.boolean().optional(),
});

export type OidcLoginStart = Readonly<{
  authorizationUrl: string;
  expiresAt: Date;
  browserBindingMaxAgeSeconds: number;
  /** Raw, one-time value for the HTTP cookie boundary. Never serialize it in a response body. */
  browserBinding: string;
}>;

export type OidcLoginResult = Readonly<{
  externalIdentity: ExternalIdentity;
  internalIdentity: Readonly<{
    userId: string;
    authenticationIdentityId?: string;
  }>;
  verifiedProfile: VerifiedOidcProfile;
}>;

const systemClock: IdentityClock = { now: () => new Date() };

/** Standards-level OIDC application service; vendor SDKs belong behind OidcProviderPort. */
export class OidcLoginService {
  private readonly configuration: OidcConfiguration;
  private readonly crypto: IdentityCrypto;
  private readonly clock: IdentityClock;

  constructor(
    configuration: OidcConfiguration,
    private readonly transactions: OidcLoginTransactionStore,
    private readonly provider: OidcProviderPort,
    private readonly identityMapper: InternalIdentityMapperPort,
    options: Readonly<{ crypto?: IdentityCrypto; clock?: IdentityClock }> = {},
  ) {
    try {
      this.configuration = oidcConfigurationSchema.parse(configuration);
    } catch {
      throw new IdentityError('identity.invalid_input');
    }
    this.crypto = options.crypto ?? nodeIdentityCrypto;
    this.clock = options.clock ?? systemClock;
  }

  async startLogin(): Promise<OidcLoginStart> {
    const now = this.clock.now();
    const state = encodeBase64Url(this.crypto.randomBytes(32));
    const browserBinding = encodeBase64Url(this.crypto.randomBytes(32));
    const nonce = encodeBase64Url(this.crypto.randomBytes(32));
    // 32 random bytes encode to 43 chars, within RFC 7636's 43..128 range.
    const codeVerifier = encodeBase64Url(this.crypto.randomBytes(32));
    const expiresAt = new Date(
      now.getTime() + this.configuration.transactionTtlMillis,
    );
    try {
      await this.transactions.create(
        Object.freeze({
          stateDigest: digestSha256Hex(state, this.crypto),
          browserBindingDigest: digestSha256Hex(browserBinding, this.crypto),
          codeVerifier,
          nonce,
          expiresAt,
        }),
      );
    } catch {
      throw new IdentityError('identity.callback_rejected');
    }

    const request: OidcAuthorizationRequest = Object.freeze({
      state,
      nonce,
      codeChallenge: digestBase64Url(codeVerifier, this.crypto),
      codeChallengeMethod: 'S256',
      redirectUri: this.configuration.redirectUri,
      clientId: this.configuration.clientId,
      scopes: this.configuration.scopes,
    });

    let authorizationUrl: string;
    try {
      authorizationUrl = this.provider.authorizationUrl(request);
    } catch (error: unknown) {
      throw providerBoundaryError(error);
    }
    try {
      if (
        typeof authorizationUrl !== 'string' ||
        authorizationUrl.length > 8_192
      ) {
        throw new Error('invalid provider authorization URL');
      }
      const parsedUrl = new URL(authorizationUrl);
      if (
        (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') ||
        parsedUrl.username.length > 0 ||
        parsedUrl.password.length > 0
      ) {
        throw new Error('invalid provider authorization URL');
      }
      return Object.freeze({
        authorizationUrl: parsedUrl.toString(),
        expiresAt,
        browserBindingMaxAgeSeconds: Math.floor(
          this.configuration.transactionTtlMillis / 1_000,
        ),
        browserBinding,
      });
    } catch {
      // The transaction remains bounded and will expire; no provider data is exposed.
      throw new IdentityError('identity.provider_rejected');
    }
  }

  async completeLogin(
    input: OidcCallbackInput,
    browserBinding: string | undefined,
  ): Promise<OidcLoginResult> {
    let callback: OidcCallbackInput;
    try {
      callback = oidcCallbackInputSchema.parse(input);
    } catch {
      throw new IdentityError('identity.invalid_input');
    }
    if (browserBinding === undefined || browserBinding.length > 512) {
      throw new IdentityError('identity.callback_rejected');
    }

    const now = this.clock.now();
    let consumed;
    try {
      consumed = await this.transactions.consume(
        digestSha256Hex(callback.state, this.crypto),
        digestSha256Hex(browserBinding, this.crypto),
        now,
      );
    } catch {
      throw new IdentityError('identity.callback_rejected');
    }
    if (consumed === undefined || consumed.status === 'missing') {
      throw new IdentityError('identity.transaction_missing');
    }
    if (consumed.status === 'expired') {
      throw new IdentityError('identity.transaction_expired');
    }
    if (consumed.status === 'replayed') {
      throw new IdentityError('identity.transaction_replayed');
    }
    if (consumed.status === 'binding_mismatch') {
      throw new IdentityError('identity.callback_rejected');
    }
    const transaction = consumed.transaction;
    if (transaction === undefined) {
      throw new IdentityError('identity.transaction_missing');
    }
    if (now.getTime() >= transaction.expiresAt.getTime()) {
      throw new IdentityError('identity.transaction_expired');
    }

    let tokenResponse: unknown;
    try {
      tokenResponse = await this.provider.exchangeCode({
        code: callback.code,
        codeVerifier: transaction.codeVerifier,
        redirectUri: this.configuration.redirectUri,
      });
    } catch (error: unknown) {
      throw providerBoundaryError(error);
    }

    let claims: z.output<typeof tokenResponseSchema>;
    try {
      claims = tokenResponseSchema.parse(tokenResponse);
    } catch {
      throw new IdentityError('identity.callback_rejected');
    }
    if (claims.issuer !== this.configuration.issuer) {
      throw new IdentityError('identity.issuer_mismatch');
    }
    const audiences = Array.isArray(claims.audience)
      ? claims.audience
      : [claims.audience];
    if (!audiences.includes(this.configuration.clientId)) {
      throw new IdentityError('identity.audience_mismatch');
    }
    if (
      !constantTimeStringEqual(claims.nonce, transaction.nonce, this.crypto)
    ) {
      throw new IdentityError('identity.nonce_mismatch');
    }
    if (claims.subject.length === 0) {
      throw new IdentityError('identity.subject_missing');
    }
    if (claims.email === undefined || claims.displayName === undefined) {
      throw new IdentityError('identity.profile_incomplete');
    }

    const externalIdentity = Object.freeze({
      issuer: claims.issuer,
      subject: claims.subject,
    });
    const verifiedProfile: VerifiedOidcProfile = Object.freeze({
      email: claims.email,
      displayName: claims.displayName,
      ...(claims.emailVerified === undefined
        ? {}
        : { emailVerified: claims.emailVerified }),
    });
    let internalIdentity;
    try {
      internalIdentity = await this.identityMapper.mapExternalIdentity(
        externalIdentity,
        verifiedProfile,
      );
    } catch {
      throw new IdentityError('identity.mapping_failed');
    }
    if (internalIdentity === undefined) {
      throw new IdentityError('identity.mapping_failed');
    }
    let validatedInternalIdentity;
    try {
      validatedInternalIdentity =
        internalIdentitySchema.parse(internalIdentity);
    } catch {
      throw new IdentityError('identity.mapping_failed');
    }
    const normalizedInternalIdentity = Object.freeze({
      userId: validatedInternalIdentity.userId,
      ...(validatedInternalIdentity.authenticationIdentityId === undefined
        ? {}
        : {
            authenticationIdentityId:
              validatedInternalIdentity.authenticationIdentityId,
          }),
    });
    return Object.freeze({
      externalIdentity,
      internalIdentity: normalizedInternalIdentity,
      verifiedProfile,
    });
  }
}

function providerBoundaryError(error: unknown): IdentityError {
  if (
    isIdentityError(error) &&
    (error.code === 'identity.provider_rejected' ||
      error.code === 'identity.provider_unavailable')
  ) {
    return error;
  }
  return new IdentityError(
    isIdentityError(error)
      ? 'identity.provider_rejected'
      : 'identity.provider_unavailable',
  );
}
