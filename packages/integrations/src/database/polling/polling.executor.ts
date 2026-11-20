import { DATABASE_POLL_TRIGGER } from '@pertexo/workflow-model';
import { createPollingExecutor } from '../../providers/polling-trigger.js';

export const databasePollExecutor = createPollingExecutor(
  DATABASE_POLL_TRIGGER,
);
