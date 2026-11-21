import type { ModelCredential } from './connections.definition.js';
import { MODEL_LIMITS, type ModelConfig } from './model/model.schemas.js';

export type RejectedAnswer = Readonly<{ answer: unknown }>;

export type ModelRequest = Readonly<{
  endpoint: ModelCredential['endpoint'];
  config: ModelConfig;
  prompt: string;
  maxTokens: number;
}>;

export function modelRequest(
  endpoint: ModelRequest['endpoint'],
  config: ModelConfig,
  prompt: string,
  repair?: RejectedAnswer,
): ModelRequest {
  const maxTokens = config.maxOutputTokens ?? MODEL_LIMITS.defaultOutputTokens;
  if (config.mode === 'text') return { endpoint, config, prompt, maxTokens };

  const task = JSON.stringify({ task: prompt, schema: config.outputSchema });
  const instruction =
    endpoint === 'anthropic'
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
    prompt: `${instruction}\n${task}${correction}`,
  };
}
