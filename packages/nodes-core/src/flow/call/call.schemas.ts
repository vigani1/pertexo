import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { workflowCallConfigSchema } from '@pertexo/workflow-model';
import { z } from 'zod';

export const CORE_CALL_CONFIG_SCHEMA = workflowCallConfigSchema;
export const CORE_CALL_INPUT_SCHEMA = z
  .object({ input: boundedNodeJsonSchema.pipe(z.json()) })
  .strict();
export const CORE_CALL_OUTPUT_SCHEMA = boundedNodeJsonSchema;
