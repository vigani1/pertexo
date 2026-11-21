import { fetchDatabasePollItems } from './polling/fetch-items.js';
import { PollFailure } from '@pertexo/workflow-model';
import { POSTGRES_FAILURE_CODES } from '@pertexo/workflow-model';
import { POSTGRES_CONNECTION } from './connections.definition.js';
import { createDatabaseExecutorRegistration } from './execute/execute.executor.js';
import { databasePollExecutor } from './polling/polling.executor.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import { DATABASE_DEFINITION_REGISTRATION } from './execute/execute.definition.js';
import { DATABASE_POLL_DEFINITION_REGISTRATION } from './polling/polling.definition.js';

export const DATABASE_MODULE = {
  key: 'postgres',
  presentation: { name: 'Database', icon: 'database', group: 'action' },
  executorSummaryCodes: [
    ...POSTGRES_FAILURE_CODES.map((code) => `database.${code}`),
  ],
  connections: [POSTGRES_CONNECTION],
  steps: [
    {
      registration: DATABASE_DEFINITION_REGISTRATION,
      createExecutor: ({ database }) =>
        createDatabaseExecutorRegistration(database),
    },
    {
      registration: DATABASE_POLL_DEFINITION_REGISTRATION,
      createExecutor: () => databasePollExecutor,
      fetchPoll: async ({ config, ...input }, { database, connections }) => {
        if (!('source' in config))
          throw new PollFailure('database.poll_invalid_key');
        const { connectionId, source: _source, ...settings } = config;
        return fetchDatabasePollItems(
          { ...input, config: settings, connectionId },
          database,
          connections?.(),
        );
      },
      presentation: { icon: 'webhook', group: 'trigger' },
    },
  ],
} satisfies IntegrationModule;
