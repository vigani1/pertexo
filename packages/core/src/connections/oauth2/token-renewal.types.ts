import type {
  OAuth2ClientSettings,
  OAuth2ServiceError,
  OAuth2StepFailureCode,
} from '@pertexo/contracts';

export type OAuth2AccessToken = Readonly<{
  accessToken: string;
  tokenVersionId: string;
  secretVersionId: string;
  requestHosts: OAuth2ClientSettings['requestHosts'];
}>;

export type OAuth2TokenFailure = Error &
  Readonly<{
    code: OAuth2StepFailureCode;
    retryAfterSeconds?: number | undefined;
    serviceError?: OAuth2ServiceError | undefined;
  }>;

export type OAuth2RenewalProtocol = Readonly<{
  requestToken(
    settings: OAuth2ClientSettings,
    clientSecret: string,
    request:
      | Readonly<{ grantType: 'client_credentials' }>
      | Readonly<{ grantType: 'refresh_token'; refreshToken: string }>,
  ): Promise<OAuth2TokenAnswer>;
  decodeClientSettings(value: unknown): OAuth2ClientSettings;
  TokenFailure: new (
    code: OAuth2StepFailureCode,
    retryAfterSeconds?: number,
    serviceError?: OAuth2ServiceError,
  ) => OAuth2TokenFailure;
}>;

/** Outcomes the connection lifecycle needs from its injected token endpoint. */
export type OAuth2TokenAnswer =
  | Readonly<{
      kind: 'issued';
      accessToken: string;
      refreshToken?: string;
      expiresInSeconds: number | null;
    }>
  | Readonly<{ kind: 'grant_lost' | 'client_refused' | 'address_blocked' }>
  | Readonly<{
      kind: 'rate_limited' | 'unavailable';
      retryAfterSeconds: number;
    }>
  | Readonly<{
      kind: 'invalid';
      retryAfterSeconds: number;
      serviceError?: OAuth2ServiceError;
    }>;
