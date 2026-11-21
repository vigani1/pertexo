import type { ConnectionFormDefinition } from '@pertexo/contracts';
import type { OAuth2Draft } from './oauth2-draft';

type Presets = NonNullable<ConnectionFormDefinition['presets']>;
const SETUP: Readonly<Record<string, string>> = {
  google:
    'In Google Cloud, create an OAuth client of type Web application and add the redirect URL above. Change the scope to what your API needs.',
  microsoft:
    'In Microsoft Entra, register an app, add the redirect URL above as a Web platform and create a client secret. If the app is for one organization, replace common in both URLs with your tenant ID. Change the scope to what your API needs, and keep offline_access.',
};

export function oauth2Services(presets: Presets) {
  return [
    { value: 'custom', label: 'Other service' },
    ...presets.map(({ key, label }) => ({ value: key, label })),
  ];
}

export function oauth2ServiceOf(draft: OAuth2Draft, presets: Presets): string {
  const host = (address: string): string | undefined =>
    URL.canParse(address) ? new URL(address).hostname : undefined;
  return (
    presets.find(({ values }) => host(values.tokenUrl) === host(draft.tokenUrl))
      ?.key ?? 'custom'
  );
}

export function oauth2ServiceSetup(service: string): string | undefined {
  return SETUP[service];
}

/** Keeps what a person typed for their own client: the ID and secret. */
export function withOAuth2Service(
  draft: OAuth2Draft,
  service: string,
  presets: Presets,
): OAuth2Draft {
  const preset = presets.find(({ key }) => key === service);
  if (preset !== undefined) return { ...draft, ...preset.values };
  return {
    ...draft,
    authorizationUrl: '',
    tokenUrl: '',
    scope: '',
    clientAuthentication: 'basic',
    pkce: 's256',
    authorizationParameters: '',
    tokenParameters: '',
    hostMode: 'any',
    hosts: '',
  };
}
