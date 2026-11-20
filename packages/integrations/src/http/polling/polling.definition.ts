import {
  HTTP_POLL_CONNECTION_SLOT,
  HTTP_POLL_TRIGGER,
  httpPollConfigSchema,
} from '@pertexo/workflow-model';
import { registerPollingDefinition } from '../../providers/polling-trigger.js';
import { httpRequestConfigSchema } from '../request/request.schemas.js';

const configSchema = httpPollConfigSchema.extend({
  url: httpRequestConfigSchema
    .unwrap()
    .shape.url.meta(httpPollConfigSchema.shape.url.meta() ?? {}),
});

export const HTTP_POLL_DEFINITION_REGISTRATION = registerPollingDefinition({
  definition: HTTP_POLL_TRIGGER,
  display: {
    name: 'HTTP Polling',
    description: 'Start a run for each new item in a JSON feed',
  },
  configSchema,
  connectionSlot: HTTP_POLL_CONNECTION_SLOT,
  optionalConnection: true,
  runtimeOnlySemantics: [
    'Items and item key paths must use the supported JSON path syntax.',
  ],
});
