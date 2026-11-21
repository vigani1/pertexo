import { POSTGRES_CONNECTION } from './connections.definition.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import { DATABASE_DEFINITION_REGISTRATION } from './execute/execute.definition.js';
import { DATABASE_POLL_DEFINITION_REGISTRATION } from './polling/polling.definition.js';

export const DATABASE_MODULE = {
  key: 'postgres',
  presentation: { name: 'Database', icon: 'database', group: 'action' },
  connections: [POSTGRES_CONNECTION],
  steps: [
    { registration: DATABASE_DEFINITION_REGISTRATION },
    {
      registration: DATABASE_POLL_DEFINITION_REGISTRATION,
      presentation: { icon: 'webhook', group: 'trigger' },
    },
  ],
} satisfies IntegrationModule;
