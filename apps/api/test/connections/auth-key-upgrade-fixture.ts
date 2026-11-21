export const CLIENT_SECRET = 'oauth2-upgrade-fixture';
const OAUTH_SETTINGS = {
  tokenUrl: 'https://auth.example.test/token',
  clientId: 'workflows',
  scope: '',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
};

export const credentials = [
  [
    'http',
    { type: 'http_headers', headers: { authorization: 'Bearer fixture' } },
  ],
  ['slack', { type: 'slack_bot_token', botToken: 'xoxb-1234567890' }],
  [
    'email',
    {
      type: 'resend_api_key',
      apiKey: 're_1234567890',
      fromEmail: 'ops@example.test',
    },
  ],
  [
    'email',
    {
      type: 'smtp',
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      username: 'ops',
      password: 'fixture-password',
      fromEmail: 'ops@example.test',
    },
  ],
  [
    'postgres',
    {
      type: 'postgres',
      host: 'database.example.test',
      port: 5432,
      database: 'app',
      user: 'workflow',
      password: 'fixture-password',
      tls: 'require',
    },
  ],
  ['signing', { type: 'hmac_key', signingKey: 'upgrade fixture key' }],
  [
    'http',
    {
      type: 'oauth2',
      clientSecret: CLIENT_SECRET,
      settings: {
        ...OAUTH_SETTINGS,
        grantType: 'client_credentials',
      },
    },
  ],
  [
    'http',
    {
      type: 'oauth2',
      clientSecret: CLIENT_SECRET,
      settings: {
        ...OAUTH_SETTINGS,
        grantType: 'authorization_code',
        authorizationUrl: 'https://auth.example.test/authorize',
        authorizationParameters: {},
        pkce: 's256',
      },
    },
  ],
] as const;
