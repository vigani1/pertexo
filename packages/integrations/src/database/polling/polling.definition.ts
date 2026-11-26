import {
  DATABASE_POLL_TRIGGER,
  databasePollConfigSchema,
  POSTGRES_CONNECTION_SLOT,
} from '@pertexo/workflow-model';

import { registerPollingDefinition } from '../../providers/polling-trigger.js';

export const DATABASE_POLL_DEFINITION_REGISTRATION = registerPollingDefinition({
  definition: DATABASE_POLL_TRIGGER,
  display: {
    name: 'Database Row',
    description: 'Start a run for each new or updated PostgreSQL row',
  },
  configSchema: databasePollConfigSchema,
  assistantDisclosure: {
    config: {
      visible: [
        'schema',
        'table',
        'orderingColumn',
        'keyColumn',
        'intervalMinutes',
        'mode',
      ],
      masked: [],
    },
  },
  connectionSlot: POSTGRES_CONNECTION_SLOT,
});
