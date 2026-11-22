import { MODEL_LIMITS } from './model-settings.js';
import type { ModelCredential } from './connections.definition.js';
import type { ModelConfig } from './model/model.schemas.js';

import type { AgentModelContext } from './agent/agent-request.js';

export type RejectedAnswer = Readonly<{ answer: unknown }>;

export type ModelRequest = Readonly<{
  endpoint: ModelCredential['endpoint'];
  prompt: string;
  maxTokens: number;
  structuredResponse?: 'prompt';
}> &
  (
    | Readonly<{ config: ModelConfig; agent?: never }>
    | Readonly<{
        config: Extract<ModelConfig, { mode: 'text' }>;
        agent: AgentModelContext;
      }>
  );

export function modelRequest(
  endpoint: ModelRequest['endpoint'],
  config: ModelConfig,
  prompt: string,
  repair?: RejectedAnswer,
  structuredResponse?: 'prompt',
): ModelRequest {
  const maxTokens = config.maxOutputTokens ?? MODEL_LIMITS.defaultOutputTokens;
  if (config.mode === 'text') return { endpoint, config, prompt, maxTokens };

  const task = JSON.stringify({ task: prompt, schema: config.outputSchema });
  const instruction =
    endpoint === 'anthropic' && structuredResponse === undefined
      ? 'Return the result using the output tool.'
      : 'Return only a JSON object matching the supplied schema.';
  const correction =
    repair === undefined
      ? ''
      : `\nThe previous answer did not match the schema. Correct this answer: ${JSON.stringify(repair.answer)}`;
  return {
    endpoint,
    config,
    maxTokens,
    ...(structuredResponse === undefined ? {} : { structuredResponse }),
    prompt: `${instruction}\n${task}${correction}`,
  };
}
