import { HMAC_KEY_CONNECTION } from './connections.definition.js';
import type { IntegrationModule } from '../providers/integration-module.js';

export const SIGNING_MODULE = {
  key: 'signing',
  presentation: { name: 'Signing key', icon: 'key', group: 'action' },
  connections: [HMAC_KEY_CONNECTION],
  steps: [],
} satisfies IntegrationModule;
