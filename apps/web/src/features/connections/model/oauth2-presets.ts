import type { OAuth2Draft } from './oauth2-draft';

export type OAuth2Service = 'custom' | 'google' | 'microsoft';

type Preset = Readonly<{
  label: string;
  setup: string;
  values: Pick<
    OAuth2Draft,
    | 'grantType'
    | 'authorizationUrl'
    | 'tokenUrl'
    | 'scope'
    | 'clientAuthentication'
    | 'pkce'
    | 'authorizationParameters'
    | 'hostMode'
    | 'hosts'
  >;
}>;

/**
 * A preset only fills in fields a person could type, and is never stored: what
 * gets saved is the same settings as any other OAuth2 connection, and every field
 * stays editable. A token can reach only the service's own API hosts.
 */
const PRESETS: Readonly<Record<Exclude<OAuth2Service, 'custom'>, Preset>> = {
  google: {
    label: 'Google',
    setup:
      'In Google Cloud, create an OAuth client of type Web application and add the redirect URL above. Change the scope to what your API needs.',
    values: {
      grantType: 'authorization_code',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/userinfo.email',
      clientAuthentication: 'body',
      pkce: 's256',
      // Without these Google gives no refresh token, and the connection stops
      // working after an hour.
      authorizationParameters: 'access_type=offline\nprompt=consent',
      hostMode: 'listed',
      hosts: '*.googleapis.com',
    },
  },
  microsoft: {
    label: 'Microsoft',
    setup:
      'In Microsoft Entra, register an app, add the redirect URL above as a Web platform and create a client secret. If the app is for one organization, replace common in both URLs with your tenant ID. Change the scope to what your API needs, and keep offline_access.',
    values: {
      grantType: 'authorization_code',
      authorizationUrl:
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'offline_access https://graph.microsoft.com/User.Read',
      clientAuthentication: 'body',
      pkce: 's256',
      authorizationParameters: '',
      hostMode: 'listed',
      hosts: 'graph.microsoft.com',
    },
  },
};

export const OAUTH2_SERVICES: readonly Readonly<{
  value: OAuth2Service;
  label: string;
}>[] = [
  { value: 'custom', label: 'Other service' },
  { value: 'google', label: PRESETS.google.label },
  { value: 'microsoft', label: PRESETS.microsoft.label },
];

/**
 * Worked out from the addresses, so nothing extra is kept and a saved connection
 * reads the same way. A tenant ID in place of `common` is still Microsoft.
 */
export function oauth2ServiceOf(draft: OAuth2Draft): OAuth2Service {
  const host = (address: string): string | undefined =>
    URL.canParse(address) ? new URL(address).hostname : undefined;
  if (host(draft.tokenUrl) === 'oauth2.googleapis.com') return 'google';
  if (host(draft.tokenUrl) === 'login.microsoftonline.com') return 'microsoft';
  return 'custom';
}

export function oauth2ServiceSetup(service: OAuth2Service): string | undefined {
  return service === 'custom' ? undefined : PRESETS[service].setup;
}

/** Keeps what a person typed for their own client: the ID and secret. */
export function withOAuth2Service(
  draft: OAuth2Draft,
  service: OAuth2Service,
): OAuth2Draft {
  if (service !== 'custom') return { ...draft, ...PRESETS[service].values };
  return {
    ...draft,
    authorizationUrl: '',
    tokenUrl: '',
    scope: '',
    clientAuthentication: 'basic',
    pkce: 's256',
    authorizationParameters: '',
    hostMode: 'any',
    hosts: '',
  };
}
