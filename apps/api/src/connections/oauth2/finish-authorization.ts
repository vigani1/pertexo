import { generatePersistedId } from '@pertexo/database/platform';
import {
  OAUTH2_LANDING_PATH,
  oauth2CallbackQuerySchema,
  type OAuth2CallbackLanding,
} from '@pertexo/contracts';
import {
  decodeClientSettings,
  decodeStoredClientSecret,
  encodeStoredTokens,
  isRenewable,
  oauth2Digest,
  oauth2StateWorkspace,
  requestOAuth2Token,
  withCommitAttempts,
  type OAuth2TokenAnswer,
} from '@pertexo/integrations/server';

import type {
  ConnectionOAuth2Dependencies,
  ConnectionSecretEncryptionPort,
} from '../ports.js';
import {
  OAUTH2_BINDING_COOKIE_PREFIX,
  oauth2BindingCookieName,
  oauth2RedirectUri,
  oauth2Verifier,
} from './start-authorization.js';

/** Each browser holds one cookie per consent it started in the last ten minutes. */
const MAXIMUM_BINDING_COOKIES = 32;
/** Nothing here belongs to a request that may close: see S10. */
const CIPHER_TIMEOUT_MILLIS = 30_000;

type Consumed = Extract<
  Awaited<
    ReturnType<
      ConnectionOAuth2Dependencies['persistence']['consumeOAuth2Authorization']
    >
  >,
  { kind: 'consumed' }
>;

export type FinishedOAuth2 = Readonly<{
  location: string;
  /** Set once the row is consumed: until then the right browser may still need it. */
  clearCookie?: string;
}>;

const INVALID: OAuth2CallbackLanding = Object.freeze({ result: 'invalid' });

function bindingDigests(cookieHeader: string | undefined): readonly Buffer[] {
  return (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(OAUTH2_BINDING_COOKIE_PREFIX))
    .slice(0, MAXIMUM_BINDING_COOKIES)
    .map((part) => oauth2Digest(part.slice(part.indexOf('=') + 1)));
}

function landingOfAnswer(
  answer: OAuth2TokenAnswer,
): 'token_refused' | 'provider_unavailable' {
  return answer.kind === 'rate_limited' || answer.kind === 'unavailable'
    ? 'provider_unavailable'
    : 'token_refused';
}

/**
 * Where a provider returns the browser. The state and its binding cookie stand in
 * for a session, which `SameSite=Strict` hides on the way back. Every outcome is a
 * landing page; exchange and commit don't follow the request, so closing the tab
 * can't lose a code that has already been spent.
 */
export class FinishOAuth2AuthorizationUseCase {
  public constructor(
    private readonly oauth2: ConnectionOAuth2Dependencies,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly applicationSecret: string,
  ) {}

  public async execute(
    input: Readonly<{ query: unknown; cookieHeader: string | undefined }>,
  ): Promise<FinishedOAuth2> {
    const query = oauth2CallbackQuerySchema.safeParse(input.query);
    if (!query.success) return this.land(INVALID);
    const workspaceId = oauth2StateWorkspace(query.data.state);
    if (workspaceId === undefined) return this.land(INVALID);
    const consumed = await this.oauth2.persistence.consumeOAuth2Authorization({
      workspaceId,
      stateDigest: oauth2Digest(query.data.state),
      bindingDigests: bindingDigests(input.cookieHeader),
    });
    if (consumed.kind === 'unknown') return this.land(INVALID);
    const clearCookie = oauth2BindingCookieName(consumed.connectionId);
    if (consumed.kind === 'refused') return this.land(INVALID, clearCookie);
    const named = { workspaceId, connectionId: consumed.connectionId };
    if (query.data.kind === 'error')
      return this.land(
        {
          result:
            query.data.error === 'access_denied' ? 'denied' : 'token_refused',
          ...named,
        },
        clearCookie,
      );
    const result = await this.exchange(
      workspaceId,
      consumed,
      query.data.code,
      query.data.state,
    );
    return this.land(
      result === 'invalid' ? INVALID : { result, ...named },
      clearCookie,
    );
  }

  /** A code is sent once: a failure here is shown, never retried. */
  private async exchange(
    workspaceId: string,
    consumed: Consumed,
    code: string,
    state: string,
  ): Promise<
    'connected' | 'invalid' | 'token_refused' | 'provider_unavailable'
  > {
    const settings = decodeClientSettings(consumed.settings);
    const bytes = await this.encryption.open(
      consumed.clientSecret,
      {
        workspaceId,
        connectionId: consumed.connectionId,
        secretVersionId: consumed.secretVersionId,
      },
      AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
    );
    let clientSecret: string;
    try {
      clientSecret = decodeStoredClientSecret(bytes);
    } finally {
      bytes.fill(0);
    }
    const answer = await requestOAuth2Token(
      this.oauth2.tokenClient,
      settings,
      clientSecret,
      {
        grantType: 'authorization_code',
        code,
        redirectUri: oauth2RedirectUri(
          this.oauth2.endpointPolicy.publicWebOrigin,
        ),
        ...(settings.grantType === 'authorization_code' &&
        settings.pkce === 's256'
          ? { codeVerifier: oauth2Verifier(this.applicationSecret, state) }
          : {}),
      },
    );
    if (answer.kind !== 'issued') return landingOfAnswer(answer);
    const tokens = {
      accessToken: answer.accessToken,
      ...(answer.refreshToken === undefined
        ? {}
        : { refreshToken: answer.refreshToken }),
    };
    const id = generatePersistedId();
    const plaintext = encodeStoredTokens(tokens);
    try {
      const sealed = await this.encryption.seal(
        plaintext,
        {
          workspaceId,
          connectionId: consumed.connectionId,
          secretVersionId: id,
        },
        AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
      );
      const connection = await withCommitAttempts(() =>
        this.oauth2.persistence.authorizeOAuth2Connection({
          workspaceId,
          connectionId: consumed.connectionId,
          actorId: consumed.startedBy,
          secretVersionId: consumed.secretVersionId,
          issued: {
            id,
            sealed,
            expiresInSeconds: answer.expiresInSeconds,
            renewable: isRenewable(settings, tokens),
          },
        }),
      );
      return connection === null ? 'invalid' : 'connected';
    } finally {
      plaintext.fill(0);
    }
  }

  private land(
    landing: OAuth2CallbackLanding,
    clearCookie?: string,
  ): FinishedOAuth2 {
    const url = new URL(
      OAUTH2_LANDING_PATH,
      this.oauth2.endpointPolicy.publicWebOrigin,
    );
    for (const [name, value] of Object.entries(landing))
      url.searchParams.set(name, value);
    return Object.freeze({
      location: url.toString(),
      ...(clearCookie === undefined ? {} : { clearCookie }),
    });
  }
}
