export type SettingsOverrides = Readonly<Record<string, unknown>>;

const shared = (origin: string, clientId: string) => ({
  tokenUrl: `${origin}/token`,
  clientId,
  scope: 'read',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
});

/** A sign-in-with-consent client of the stand-in at this origin. */
export const consentSettings = (
  origin: string,
  clientId: string,
  overrides: SettingsOverrides = {},
) => ({
  grantType: 'authorization_code',
  authorizationUrl: `${origin}/authorize`,
  authorizationParameters: {},
  pkce: 's256',
  ...shared(origin, clientId),
  ...overrides,
});

/** A server-to-server client of the stand-in at this origin. */
export const serverSettings = (
  origin: string,
  clientId: string,
  overrides: SettingsOverrides = {},
) => ({
  grantType: 'client_credentials',
  ...shared(origin, clientId),
  ...overrides,
});
