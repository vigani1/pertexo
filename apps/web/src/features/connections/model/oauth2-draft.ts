import {
  oauth2CredentialSchema,
  type OAuth2ClientSettings,
  type OAuth2Credential,
} from '@pertexo/contracts';

export type OAuth2Draft = Readonly<{
  provider: 'oauth2';
  grantType: OAuth2ClientSettings['grantType'];
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  clientAuthentication: OAuth2ClientSettings['clientAuthentication'];
  pkce: 's256' | 'none';
  /** One `name=value` a line: a person's text until it is saved. */
  authorizationParameters: string;
  tokenParameters: string;
  hostMode: 'any' | 'listed';
  /** One host a line. */
  hosts: string;
}>;

export type OAuth2Field =
  | 'authorizationUrl'
  | 'tokenUrl'
  | 'clientId'
  | 'clientSecret'
  | 'scope'
  | 'authorizationParameters'
  | 'tokenParameters'
  | 'hosts';

export function emptyOAuth2Draft(): OAuth2Draft {
  return {
    provider: 'oauth2',
    grantType: 'authorization_code',
    authorizationUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    clientAuthentication: 'basic',
    pkce: 's256',
    authorizationParameters: '',
    tokenParameters: '',
    hostMode: 'any',
    hosts: '',
  };
}

function parameterText(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

/** Every setting as stored. The secret stays empty: it must be typed again (S22). */
export function draftFromSettings(settings: OAuth2ClientSettings): OAuth2Draft {
  return {
    ...emptyOAuth2Draft(),
    grantType: settings.grantType,
    tokenUrl: settings.tokenUrl,
    clientId: settings.clientId,
    scope: settings.scope,
    clientAuthentication: settings.clientAuthentication,
    tokenParameters: parameterText(settings.tokenParameters),
    hostMode: settings.requestHosts.mode,
    hosts:
      settings.requestHosts.mode === 'listed'
        ? settings.requestHosts.hosts.join('\n')
        : '',
    ...(settings.grantType === 'authorization_code'
      ? {
          authorizationUrl: settings.authorizationUrl,
          authorizationParameters: parameterText(
            settings.authorizationParameters,
          ),
          pkce: settings.pkce,
        }
      : {}),
  };
}

const lines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

function parseParameters(
  text: string,
): Readonly<Record<string, string>> | undefined {
  const entries: (readonly [string, string])[] = [];
  for (const line of lines(text)) {
    const split = line.indexOf('=');
    if (split < 1) return undefined;
    entries.push([line.slice(0, split).trim(), line.slice(split + 1).trim()]);
  }
  return Object.fromEntries(entries);
}

function settingsOf(draft: OAuth2Draft) {
  const shared = {
    tokenUrl: draft.tokenUrl.trim(),
    clientId: draft.clientId.trim(),
    scope: draft.scope.trim(),
    clientAuthentication: draft.clientAuthentication,
    tokenParameters: parseParameters(draft.tokenParameters) ?? {},
    requestHosts:
      draft.hostMode === 'any'
        ? ({ mode: 'any' } as const)
        : ({
            mode: 'listed',
            hosts: lines(draft.hosts).map((host) => host.toLowerCase()),
          } as const),
  };
  return draft.grantType === 'client_credentials'
    ? ({ grantType: 'client_credentials', ...shared } as const)
    : ({
        grantType: 'authorization_code',
        authorizationUrl: draft.authorizationUrl.trim(),
        authorizationParameters:
          parseParameters(draft.authorizationParameters) ?? {},
        pkce: draft.pkce,
        ...shared,
      } as const);
}

/** The contract credential: only a draft with no errors reaches the API. */
export function toOAuth2Credential(draft: OAuth2Draft): OAuth2Credential {
  return oauth2CredentialSchema.parse({
    type: 'oauth2',
    settings: settingsOf(draft),
    clientSecret: draft.clientSecret.trim(),
  });
}

const FIELD_MESSAGES: Readonly<Record<OAuth2Field, string>> = {
  authorizationUrl:
    'Enter a full web address, with no password or #section, and leave out parameters Pertexo sets, like client_id or state.',
  tokenUrl:
    'Enter a full web address, with no password or #section, and leave out parameters Pertexo sets, like client_id or code.',
  clientId: 'Enter the client ID the service gave you.',
  clientSecret: 'Enter the client secret the service gave you.',
  scope: 'Scopes use plain letters, numbers and punctuation.',
  authorizationParameters:
    'Write one name=value a line, and leave out parameters Pertexo sets.',
  tokenParameters:
    'Write one name=value a line, and leave out parameters Pertexo sets.',
  hosts: 'List one host a line, like api.example.com or *.example.com.',
};

function fieldOfPath(path: readonly PropertyKey[]): OAuth2Field | undefined {
  const [first, second] = path;
  if (first === 'clientSecret') return 'clientSecret';
  if (first !== 'settings') return undefined;
  if (second === 'requestHosts') return 'hosts';
  return Object.hasOwn(FIELD_MESSAGES, String(second))
    ? (String(second) as OAuth2Field)
    : undefined;
}

/** The contract decides what is valid, once; this only says it in words. */
export function oauth2DraftErrors(
  draft: OAuth2Draft,
): Partial<Record<OAuth2Field, string>> {
  const errors: Partial<Record<OAuth2Field, string>> = {};
  const parsed = oauth2CredentialSchema.safeParse({
    type: 'oauth2',
    settings: settingsOf(draft),
    clientSecret: draft.clientSecret.trim(),
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = fieldOfPath(issue.path);
      if (field !== undefined) errors[field] = FIELD_MESSAGES[field];
    }
  if (parseParameters(draft.tokenParameters) === undefined)
    errors.tokenParameters = FIELD_MESSAGES.tokenParameters;
  if (
    draft.grantType === 'authorization_code' &&
    parseParameters(draft.authorizationParameters) === undefined
  )
    errors.authorizationParameters = FIELD_MESSAGES.authorizationParameters;
  return errors;
}

/** Server issues at `credential.settings.*` and `credential.clientSecret`. */
export function oauth2ServerErrors(
  issues: readonly Readonly<{ path: string; code: string }>[],
): Partial<Record<OAuth2Field, string>> {
  const errors: Partial<Record<OAuth2Field, string>> = {};
  for (const issue of issues) {
    const [root, ...path] = issue.path.split('.');
    if (root !== 'credential') continue;
    const field = fieldOfPath(path);
    if (field === undefined) continue;
    errors[field] =
      issue.code === 'endpoint_refused'
        ? 'This install doesn’t allow that address. Use a public https address, or ask an administrator to allow the private network.'
        : FIELD_MESSAGES[field];
  }
  return errors;
}
