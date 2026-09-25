import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';

export type ProviderKey = ConnectionResponse['providerKey'];

export const PROVIDER_KEYS = [
  'slack',
  'http',
  'email',
] as const satisfies readonly ProviderKey[];

type ProviderCopy = Readonly<{
  /** The provider as people know it. */
  name: string;
  /** What a connection to it lets workflows do. */
  purpose: string;
  /** The stored credential in words, e.g. "bot token". */
  credential: string;
  /** Title of the add lens. */
  connectTitle: string;
  /** Where a new connection can be used. */
  usedBy: string;
}>;

export const PROVIDERS: Readonly<Record<ProviderKey, ProviderCopy>> = {
  slack: {
    name: 'Slack',
    purpose: 'Post messages to channels',
    credential: 'bot token',
    connectTitle: 'Connect Slack',
    usedBy: 'Send Slack message steps and Slack alerts',
  },
  http: {
    name: 'HTTP',
    purpose: 'Call any HTTPS API with header auth',
    credential: 'headers',
    connectTitle: 'Connect an HTTPS API',
    usedBy: 'HTTP request steps',
  },
  email: {
    name: 'Email · Resend',
    purpose: 'Send notification email',
    credential: 'API key',
    connectTitle: 'Connect Resend',
    usedBy: 'Send email steps and email alerts',
  },
};

const PROVIDER_BY_CREDENTIAL: Readonly<
  Record<ConnectionResponse['authType'], ProviderKey>
> = {
  slack_bot_token: 'slack',
  http_headers: 'http',
  resend_api_key: 'email',
};

/**
 * The provider whose connections hold a credential type, such as a step's
 * `slack_bot_token` requirement → Slack; undefined for an unknown type.
 */
export function providerForCredential(
  credential: string,
): ProviderKey | undefined {
  return Object.entries(PROVIDER_BY_CREDENTIAL).find(
    ([type]) => type === credential,
  )?.[1];
}

export function isProviderKey(value: unknown): value is ProviderKey {
  return PROVIDER_KEYS.some((key) => key === value);
}

/** Provider and stored credential in words, e.g. "Slack · bot token". */
export function describeConnectionKind(provider: ProviderKey): string {
  const copy = PROVIDERS[provider];
  return `${copy.name} · ${copy.credential}`;
}

export function connectionNameError(name: string): string | undefined {
  const value = name.trim();
  if (value === '')
    return 'Name this connection so people can pick it in steps.';
  if (value.length > 128) return 'Keep the name under 128 characters.';
  return undefined;
}

const NAME_NOUNS: Readonly<Record<ProviderKey, string>> = {
  slack: 'Slack',
  http: 'API',
  email: 'email',
};

/** A starting name from the workspace and provider, e.g. "Northwind Ops Slack". */
export function suggestConnectionName(
  provider: ProviderKey,
  workspaceName: string,
): string {
  const noun = NAME_NOUNS[provider];
  return `${workspaceName.slice(0, 127 - noun.length).trim()} ${noun}`;
}

/** "Where do I find this?" steps for credentials people copy from a provider. */
export const CREDENTIAL_STEPS = {
  slack: [
    'Open api.slack.com/apps and pick your app, or create one for Pertexo.',
    'Under OAuth & Permissions, add the chat:write scope and install the app.',
    'Copy the Bot User OAuth Token. It starts with xoxb-.',
    'In Slack, invite the bot to each channel it should post in.',
  ],
  email: [
    'Open resend.com/api-keys and create an API key.',
    'Give it Sending access. Full access isn’t needed.',
    'Copy the key. It starts with re_ and is only shown once.',
    'Use a from address on a domain you verified in Resend.',
  ],
} as const satisfies Readonly<Record<'slack' | 'email', readonly string[]>>;
