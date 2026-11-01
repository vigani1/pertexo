import { Logger } from '@nestjs/common';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  OAUTH2_LANDING_PATH,
  oauth2CallbackQuerySchema,
  oauth2ServiceErrorSchema,
  type OAuth2CallbackLanding,
} from '@pertexo/contracts';
import {
  decodeClientSettings,
  decodeStoredClientSecret,
  decodeStoredTokens,
  encodeStoredTokens,
  isRenewable,
  isTemporaryOAuth2Error,
  oauth2Digest,
  oauth2StateWorkspace,
  requestOAuth2Token,
  withCommitAttempts,
  type OAuth2StoredTokens,
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

type Named = Readonly<{ workspaceId: string; connectionId: string }>;
type IssuedAnswer = Extract<OAuth2TokenAnswer, { kind: 'issued' }>;

const INVALID: OAuth2CallbackLanding = Object.freeze({ result: 'invalid' });

const logger = new Logger('OAuth2Callback');

/** Only the error's name: its message may quote what the callback carried. */
export function logOAuth2CallbackFailure(error: unknown): void {
  logger.error(
    `OAuth2 callback failed: ${error instanceof Error ? error.name : 'unknown'}`,
  );
}

function bindingDigests(cookieHeader: string | undefined): readonly Buffer[] {
  return (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(OAUTH2_BINDING_COOKIE_PREFIX))
    .slice(0, MAXIMUM_BINDING_COOKIES)
    .map((part) => oauth2Digest(part.slice(part.indexOf('=') + 1)));
}

function landingOfAnswer(
  answer: Exclude<OAuth2TokenAnswer, IssuedAnswer>,
  named: Named,
): OAuth2CallbackLanding {
  if (answer.kind === 'rate_limited' || answer.kind === 'unavailable')
    return { result: 'provider_unavailable', ...named };
  return {
    result: 'token_refused',
    ...named,
    ...(answer.kind === 'invalid' && answer.serviceError !== undefined
      ? { serviceError: answer.serviceError }
      : {}),
  };
}

/** S9: the service's short code may be shown, never its description. */
function landingOfConsentError(
  error: string,
  named: Named,
): OAuth2CallbackLanding {
  if (error === 'access_denied') return { result: 'denied', ...named };
  if (isTemporaryOAuth2Error(error))
    return { result: 'provider_unavailable', ...named };
  const shown = oauth2ServiceErrorSchema.safeParse(error);
  return {
    result: 'token_refused',
    ...named,
    ...(shown.success ? { serviceError: shown.data } : {}),
  };
}

/**
 * Where a provider returns the browser. The state and its binding cookie stand in
 * for a session, which `SameSite=Strict` hides on the way back. Every outcome is a
 * landing page, an unexpected failure included; exchange and commit don't follow
 * the request, so closing the tab can't lose a code that has already been spent.
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
        landingOfConsentError(query.data.error, named),
        clearCookie,
      );
    const landing = await this.exchange(
      named,
      consumed,
      query.data.code,
      query.data.state,
    ).catch((error: unknown): OAuth2CallbackLanding => {
      logOAuth2CallbackFailure(error);
      return { result: 'provider_unavailable', ...named };
    });
    return this.land(landing, clearCookie);
  }

  /** For a failure before any row was read, so it names no connection. */
  public interrupted(): FinishedOAuth2 {
    return this.land({ result: 'provider_unavailable' });
  }

  /** A code is sent once: a failure here is shown, never retried. */
  private async exchange(
    named: Named,
    consumed: Consumed,
    code: string,
    state: string,
  ): Promise<OAuth2CallbackLanding> {
    const settings = decodeClientSettings(consumed.settings);
    const bytes = await this.encryption.open(
      consumed.clientSecret,
      {
        ...named,
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
    if (answer.kind !== 'issued') return landingOfAnswer(answer, named);
    return (await this.commit(named, consumed, answer))
      ? { result: 'connected', ...named }
      : INVALID;
  }

  /** The code is spent: both the seal and the write get their attempts (L8). */
  private async commit(
    named: Named,
    consumed: Consumed,
    answer: IssuedAnswer,
  ): Promise<boolean> {
    const id = generatePersistedId();
    let held: Awaited<ReturnType<typeof this.seal>> | undefined;
    const connection = await withCommitAttempts(async () => {
      held ??= await this.seal(named, consumed, answer, id);
      return this.oauth2.persistence.authorizeOAuth2Connection({
        ...named,
        actorId: consumed.startedBy,
        secretVersionId: consumed.secretVersionId,
        issued: { id, expiresInSeconds: answer.expiresInSeconds, ...held },
      });
    });
    return connection !== null;
  }

  private async seal(
    named: Named,
    consumed: Consumed,
    answer: IssuedAnswer,
    id: string,
  ) {
    const tokens = await this.tokensToKeep(named, consumed, answer);
    const plaintext = encodeStoredTokens(tokens);
    try {
      return {
        sealed: await this.encryption.seal(
          plaintext,
          { ...named, secretVersionId: id },
          AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
        ),
        renewable: isRenewable(decodeClientSettings(consumed.settings), tokens),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * Some services give a refresh token only on first consent, so reconnecting under
   * the same settings keeps the earlier one rather than silently ending renewal.
   */
  private async tokensToKeep(
    named: Named,
    consumed: Consumed,
    { accessToken, refreshToken }: IssuedAnswer,
  ): Promise<OAuth2StoredTokens> {
    if (refreshToken !== undefined) return { accessToken, refreshToken };
    const earlier = await this.oauth2.persistence.readOAuth2EarlierTokens({
      ...named,
      secretVersionId: consumed.secretVersionId,
    });
    if (earlier === null) return { accessToken };
    const bytes = await this.encryption.open(
      earlier.sealed,
      { ...named, secretVersionId: earlier.id },
      AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
    );
    try {
      const kept = decodeStoredTokens(bytes).refreshToken;
      return {
        accessToken,
        ...(kept === undefined ? {} : { refreshToken: kept }),
      };
    } finally {
      bytes.fill(0);
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
      if (value !== undefined) url.searchParams.set(name, value);
    return Object.freeze({
      location: url.toString(),
      ...(clearCookie === undefined ? {} : { clearCookie }),
    });
  }
}
