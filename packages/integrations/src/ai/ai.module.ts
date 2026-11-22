import { CLASSIFY_REGISTRATION } from './classify/classify.definition.js';
import { AGENT_REGISTRATION } from './agent/agent.definition.js';
import { createAgentExecutor } from './agent/agent.executor.js';
import { createClassifyExecutor } from './classify/classify.executor.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import {
  MODEL_CONNECTION,
  MODEL_PROVIDER_KEY,
} from './connections.definition.js';
import { createModelClient } from './model-client.js';
import { GUARDRAILS_REGISTRATION } from './guardrails/guardrails.definition.js';
import { guardrailsExecutor } from './guardrails/guardrails.executor.js';
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
      registration: AGENT_REGISTRATION,
      createExecutor: ({ httpClient }) =>
        createAgentExecutor(createModelClient(httpClient)),
    },
    {
      registration: CLASSIFY_REGISTRATION,
      createExecutor: ({ httpClient }) =>
        createClassifyExecutor(createModelClient(httpClient)),
    },
    {
      registration: GUARDRAILS_REGISTRATION,
      createExecutor: () => guardrailsExecutor,
    },
    {
      registration: MODEL_REGISTRATION,
      createExecutor: ({ httpClient }) =>
        createModelExecutor(createModelClient(httpClient)),
    },
  ],
} satisfies IntegrationModule;
