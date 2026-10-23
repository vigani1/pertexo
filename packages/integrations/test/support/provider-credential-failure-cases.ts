import { ProviderCredentialInvalidError } from '@pertexo/node-sdk/server';

export const providerCredentialFailureCases = [
  {
    name: 'transient resolution',
    stage: 'resolve',
    error: new Error('postgres unavailable'),
    kind: 'retry',
    errorKind: 'provider',
  },
  {
    name: 'resolution cancellation',
    stage: 'resolve',
    error: new DOMException('stopping', 'AbortError'),
    kind: 'canceled',
    errorKind: 'canceled',
  },
  {
    name: 'revoked credential',
    stage: 'resolve',
    error: new ProviderCredentialInvalidError(),
    kind: 'failed',
    errorKind: 'authentication',
  },
  {
    name: 'transient dispatch fence',
    stage: 'fence',
    error: new Error('postgres unavailable'),
    kind: 'retry',
    errorKind: 'provider',
  },
  {
    name: 'dispatch-fence cancellation',
    stage: 'fence',
    error: new DOMException('stopping', 'AbortError'),
    kind: 'canceled',
    errorKind: 'canceled',
  },
  {
    name: 'rotated credential',
    stage: 'fence',
    error: new ProviderCredentialInvalidError(),
    kind: 'failed',
    errorKind: 'authentication',
  },
] as const;
