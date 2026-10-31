import {
  OAUTH2_CALLBACK_PATH,
  oauth2ConnectionErrorCodeSchema,
  type ConnectionResponse,
  type OAuth2CallbackLanding,
  type OAuth2ClientSettings,
  type OAuth2ConnectionErrorCode,
  type OAuth2ConnectionResponse,
} from '@pertexo/contracts';

/** The tab that opened consent hears from the tab it opened on this channel. */
export const OAUTH2_CHANNEL = 'pertexo.connections.oauth2';

export const LANDING_TEXT: Readonly<
  Record<OAuth2CallbackLanding['result'], string>
> = {
  connected: 'Connected. You can close this tab.',
  denied: "You didn't allow access. Nothing changed.",
  token_refused:
    "The service refused the sign-in. Check the client ID, secret and token URL. If they're right, try sending them in the request body.",
  provider_unavailable:
    "The service didn't answer. Try again in a few minutes.",
  invalid:
    'This sign-in link is no longer valid. Start again from Connections.',
};

/** What a person registers with the service: the same path the API answers on. */
export function oauth2RedirectUrl(origin: string): string {
  return `${origin}${OAUTH2_CALLBACK_PATH}`;
}

export function isOAuth2Connection(
  connection: ConnectionResponse,
): connection is OAuth2ConnectionResponse {
  return connection.authType === 'oauth2';
}

/** Host and port, so an address someone tampered with is plain to see. */
export function shownHost(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

export function signInHost(settings: OAuth2ClientSettings): string {
  return shownHost(
    settings.grantType === 'authorization_code'
      ? settings.authorizationUrl
      : settings.tokenUrl,
  );
}

export function connectSentence(settings: OAuth2ClientSettings): string {
  const token = shownHost(settings.tokenUrl);
  return settings.grantType === 'authorization_code'
    ? `You'll sign in at ${shownHost(settings.authorizationUrl)}. Pertexo then gets its token from ${token}.`
    : `Pertexo gets its token from ${token}.`;
}

function knownCode(
  code: string | null | undefined,
): OAuth2ConnectionErrorCode | undefined {
  const parsed = oauth2ConnectionErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : undefined;
}

const SHORT: Readonly<Record<OAuth2ConnectionErrorCode, string>> = {
  'connection.oauth2_not_authorized': 'not connected yet',
  'connection.oauth2_grant_revoked': 'sign-in revoked',
  'connection.oauth2_client_rejected': 'client refused',
  'connection.oauth2_token_expired': 'token expired',
};

/** The list's health sentence for an OAuth2 connection that isn't connected. */
export function oauth2ShortStatus(code: string | null): string | undefined {
  const known = knownCode(code);
  return known === undefined ? undefined : SHORT[known];
}

export function oauth2Notice(
  connection: OAuth2ConnectionResponse,
): string | undefined {
  const { settings } = connection.oauth2;
  const token = shownHost(settings.tokenUrl);
  switch (knownCode(connection.health.lastErrorCode)) {
    case 'connection.oauth2_not_authorized':
      return `Not connected yet. Connect to sign in at ${signInHost(settings)}.`;
    case 'connection.oauth2_grant_revoked':
      return `${token} no longer accepts this connection's sign-in. Reconnect to restore it.`;
    case 'connection.oauth2_client_rejected':
      return `${token} refused the client ID or secret. Replace them, then connect.`;
    case 'connection.oauth2_token_expired':
      return 'The access token expired and this service gave no way to renew it. Reconnect.';
    case undefined:
      return undefined;
  }
}

/** The button that asks for consent: there's nothing to reconnect the first time. */
export function connectLabel(
  connection: OAuth2ConnectionResponse,
): 'Connect' | 'Reconnect' {
  return connection.status !== 'active' &&
    connection.health.lastErrorCode === 'connection.oauth2_not_authorized'
    ? 'Connect'
    : 'Reconnect';
}

/** What an active grant means for the people relying on it. */
export function grantSentence(
  grant: Extract<OAuth2ConnectionResponse, { status: 'active' }>['grant'],
  formatTime: (value: string) => string,
): string {
  if (grant.renewable) return 'Token renews automatically';
  return grant.accessTokenExpiresAt === null
    ? 'The service gave no expiry'
    : `Token expires ${formatTime(grant.accessTokenExpiresAt)}; someone will need to reconnect`;
}
