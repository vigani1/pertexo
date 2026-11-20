import { HTTP_POLL_TRIGGER } from '@pertexo/workflow-model';
import { createPollingExecutor } from '../../providers/polling-trigger.js';

export const httpPollExecutor = createPollingExecutor(HTTP_POLL_TRIGGER);
