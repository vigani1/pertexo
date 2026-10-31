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
  oauth2: 'oauth2',
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
  oauth2Authorized: 'connection.oauth2_authorized',
} as const;

/**
 * Whether a connection can serve a step's slot. An HTTP step takes its token from
 * an OAuth2 connection as readily as from headers: only the step's slot is named
 * `http_headers`, and it asks for a way to authenticate, not for that format.
 */
export function connectionFitsSlot(
  connection: Readonly<{ providerKey: string; authType: string }>,
  slot: Readonly<{ providerKey: string; authType: string }>,
): boolean {
  if (connection.providerKey !== slot.providerKey) return false;
  return (
    connection.authType === slot.authType ||
    (slot.authType === CONNECTION_AUTH_TYPE.httpHeaders &&
      connection.authType === CONNECTION_AUTH_TYPE.oauth2)
  );
}

export type ConnectionTestOutcome =
  | Readonly<{ ok: true; httpStatus: number }>
  | Readonly<{
      ok: false;
      httpStatus: number | null;
      errorCode: string;
      reauthorizationRequired: boolean;
    }>;
