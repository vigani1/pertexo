export const CONNECTION_STATUS = {
  active: 'active',
  reauthorizationRequired: 'reauthorization_required',
  revoked: 'revoked',
} as const;

export type ConnectionStatus =
  (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

export const CONNECTION_AUTH_TYPE = {
  signingKey: 'hmac_key',
  httpHeaders: 'http_headers',
  slackBotToken: 'slack_bot_token',
  resendApiKey: 'resend_api_key',
} as const;

export type ConnectionAuthType =
  (typeof CONNECTION_AUTH_TYPE)[keyof typeof CONNECTION_AUTH_TYPE];

export const CONNECTION_EVENT_TYPE = {
  created: 'connection.created',
  secretRotated: 'connection.secret_rotated',
  testSucceeded: 'connection.test_succeeded',
  testFailed: 'connection.test_failed',
  reauthorizationRequired: 'connection.reauthorization_required',
  revoked: 'connection.revoked',
  credentialAccessed: 'connection.credential_accessed',
} as const;

export type ConnectionTestOutcome =
  | Readonly<{ ok: true; httpStatus: number }>
  | Readonly<{
      ok: false;
      httpStatus: number | null;
      errorCode: string;
      reauthorizationRequired: boolean;
    }>;
