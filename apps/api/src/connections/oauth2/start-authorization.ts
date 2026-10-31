import { generatePersistedId } from '@pertexo/database/platform';
import {
  OAUTH2_CALLBACK_PATH,
  oauth2ConnectionResponseSchema,
  type OAuth2AuthorizationStartResponse,
  type OAuth2ClientSettings,
} from '@pertexo/contracts';
import {
  decodeClientSettings,
  decodeStoredClientSecret,
  encodeStoredTokens,
  isRenewable,
  newOAuth2Secret,
  newOAuth2State,
  oauth2AuthorizationAddress,
  oauth2Digest,
  oauth2VerifierPurpose,
  refusedEndpoint,
  requestOAuth2Token,
  withCommitAttempts,
} from '@pertexo/integrations/server';

import { deriveJourneySecret } from '../../authentication/journeys/browser-proof.js';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { authorizeConnectionOperation } from '../authorization.js';
import type {
  ConnectionOAuth2Dependencies,
  ConnectionSecretEncryptionPort,
} from '../ports.js';
import {
  encryptionSignal,
  toResponse,
  type ConnectionCommandInput,
} from '../use-cases/support.js';
import {
  OAuth2EndpointRefusedError,
  OAuth2ProviderUnavailableError,
  OAuth2TokenRefusedError,
} from './errors.js';

const CONSENT_LIFETIME_SECONDS = 600;

export const OAUTH2_BINDING_COOKIE_PREFIX = 'pertexo_oauth2_';

export type StartOAuth2Command = ConnectionCommandInput &
  Readonly<{ connectionId: string }>;

export type StartedOAuth2 = Readonly<{
  response: OAuth2AuthorizationStartResponse;
  /** The browser-binding cookie: only consent has one. */
  setCookie?: string;
}>;

export function oauth2BindingCookieName(connectionId: string): string {
  return `${OAUTH2_BINDING_COOKIE_PREFIX}${connectionId.replaceAll('-', '')}`;
}

/** The verifier is derived, not stored, so a stolen row can't finish a consent. */
export function oauth2Verifier(
  applicationSecret: string,
  state: string,
): string {
  return deriveJourneySecret(applicationSecret, oauth2VerifierPurpose(state));
}

export const oauth2RedirectUri = (publicWebOrigin: string): string =>
  `${publicWebOrigin}${OAUTH2_CALLBACK_PATH}`;

export class StartOAuth2AuthorizationUseCase {
  public constructor(
    private readonly oauth2: ConnectionOAuth2Dependencies,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly applicationSecret: string,
  ) {}

  public async execute(input: StartOAuth2Command): Promise<StartedOAuth2> {
    await authorizeConnectionOperation(input, this.authorization);
    const scope = {
      workspaceId: input.routeWorkspaceId,
      connectionId: input.connectionId,
      actorId: input.actor.actorId,
    };
    const stored = await this.oauth2.persistence.readOAuth2Client(scope);
    const settings = decodeClientSettings(stored.settings);
    const refused = refusedEndpoint(settings, this.oauth2.endpointPolicy);
    if (refused !== undefined) throw new OAuth2EndpointRefusedError(refused);
    const secretVersionId = stored.connection.currentSecretVersionId;
    if (settings.grantType === 'client_credentials')
      return this.connectAtOnce(input, settings, stored);
    const state = newOAuth2State(input.routeWorkspaceId);
    const binding = newOAuth2Secret();
    const { expiresAt } =
      await this.oauth2.persistence.startOAuth2Authorization({
        ...scope,
        secretVersionId,
        stateDigest: oauth2Digest(state),
        bindingDigest: oauth2Digest(binding),
        lifetimeSeconds: CONSENT_LIFETIME_SECONDS,
      });
    return Object.freeze({
      response: Object.freeze({
        kind: 'consent',
        authorizationUrl: oauth2AuthorizationAddress(settings, {
          redirectUri: oauth2RedirectUri(
            this.oauth2.endpointPolicy.publicWebOrigin,
          ),
          state,
          verifier: oauth2Verifier(this.applicationSecret, state),
        }),
        expiresAt: expiresAt.toISOString(),
      }),
      setCookie: this.bindingCookie(input.connectionId, binding),
    });
  }

  private bindingCookie(connectionId: string, binding: string): string {
    const secure =
      new URL(this.oauth2.endpointPolicy.publicWebOrigin).protocol === 'https:';
    return `${oauth2BindingCookieName(connectionId)}=${binding}; Path=${OAUTH2_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${String(CONSENT_LIFETIME_SECONDS)}${secure ? '; Secure' : ''}`;
  }

  private async connectAtOnce(
    input: StartOAuth2Command,
    settings: OAuth2ClientSettings,
    stored: Awaited<
      ReturnType<
        ConnectionOAuth2Dependencies['persistence']['readOAuth2Client']
      >
    >,
  ): Promise<StartedOAuth2> {
    const secretVersionId = stored.connection.currentSecretVersionId;
    const bytes = await this.encryption.open(
      stored.clientSecret,
      {
        workspaceId: input.routeWorkspaceId,
        connectionId: input.connectionId,
        secretVersionId,
      },
      encryptionSignal(input),
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
      { grantType: 'client_credentials' },
    );
    switch (answer.kind) {
      case 'address_blocked':
        throw new OAuth2EndpointRefusedError('tokenUrl');
      case 'rate_limited':
      case 'unavailable':
        throw new OAuth2ProviderUnavailableError();
      case 'grant_lost':
      case 'client_refused':
      case 'invalid':
        throw new OAuth2TokenRefusedError();
      case 'issued':
        break;
    }
    const tokens = { accessToken: answer.accessToken };
    const id = generatePersistedId();
    const plaintext = encodeStoredTokens(tokens);
    try {
      const sealed = await this.encryption.seal(
        plaintext,
        {
          workspaceId: input.routeWorkspaceId,
          connectionId: input.connectionId,
          secretVersionId: id,
        },
        encryptionSignal(input),
      );
      const connection = await withCommitAttempts(() =>
        this.oauth2.persistence.authorizeOAuth2Connection({
          workspaceId: input.routeWorkspaceId,
          connectionId: input.connectionId,
          actorId: input.actor.actorId,
          secretVersionId,
          issued: {
            id,
            sealed,
            expiresInSeconds: answer.expiresInSeconds,
            renewable: isRenewable(settings, tokens),
          },
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        }),
      );
      if (connection === null) throw new OAuth2TokenRefusedError();
      return Object.freeze({
        response: Object.freeze({
          kind: 'connected',
          connection: oauth2ConnectionResponseSchema.parse(
            toResponse(
              connection,
              oauth2RedirectUri(this.oauth2.endpointPolicy.publicWebOrigin),
            ),
          ),
        }),
      });
    } finally {
      plaintext.fill(0);
    }
  }
}
