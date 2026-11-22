import type { z } from 'zod';
import type { ModelClient } from '../model-client.js';
import { runModel } from '../run-model.js';
import { registerProviderExecutor } from '../../providers/provider-executor.js';
import { MODEL_STEP } from './model.definition.js';
import type { ModelConfig, modelInputSchema } from './model.schemas.js';

export function createModelExecutor(
  client: ModelClient,
  now: () => number = Date.now,
) {
  return registerProviderExecutor(MODEL_STEP, undefined, (invocation) => {
    const config = invocation.config as ModelConfig;
    const { prompt } = invocation.input as z.output<typeof modelInputSchema>;
    return runModel({
      client,
      invocation,
      config,
      prompt,
      purpose: 'ai.model.execute',
      now,
    });
  });
}
