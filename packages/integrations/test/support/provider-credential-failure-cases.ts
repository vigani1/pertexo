import { ProviderCredentialInvalidError } from '@pertexo/node-sdk/server';

export const providerCredentialFailureCases = [
  [
    'transient resolution',
    'resolve',
    new Error('postgres unavailable'),
    'retry',
    'provider',
  ],
  [
    'resolution cancellation',
    'resolve',
    new DOMException('stopping', 'AbortError'),
    'canceled',
    'canceled',
  ],
  [
    'revoked credential',
    'resolve',
    new ProviderCredentialInvalidError(),
    'failed',
    'authentication',
  ],
  [
    'transient dispatch fence',
    'fence',
    new Error('postgres unavailable'),
    'retry',
    'provider',
  ],
  [
    'dispatch-fence cancellation',
    'fence',
    new DOMException('stopping', 'AbortError'),
    'canceled',
    'canceled',
  ],
  [
    'rotated credential',
    'fence',
    new ProviderCredentialInvalidError(),
    'failed',
    'authentication',
  ],
] as const;
