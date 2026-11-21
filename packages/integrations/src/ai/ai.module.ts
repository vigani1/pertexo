import type { IntegrationModule } from '../providers/integration-module.js';
import {
  MODEL_CONNECTION,
  MODEL_PROVIDER_KEY,
} from './connections.definition.js';
import { createModelClient } from './model-client.js';
import { MODEL_REGISTRATION } from './model/model.definition.js';
import { MODEL_FAILURE_CODES } from './model/model.errors.js';
import { createModelExecutor } from './model/model.executor.js';

export const AI_MODULE = {
  key: MODEL_PROVIDER_KEY,
  presentation: { name: 'AI', icon: 'sparkles', group: 'action' },
  connections: [MODEL_CONNECTION],
  executorSummaryCodes: MODEL_FAILURE_CODES,
  steps: [
    {
      registration: MODEL_REGISTRATION,
      createExecutor: ({ httpClient }) =>
        createModelExecutor(createModelClient(httpClient)),
    },
  ],
} satisfies IntegrationModule;
