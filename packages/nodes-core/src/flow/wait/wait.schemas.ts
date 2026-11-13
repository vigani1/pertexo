import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { waitConfigSchema } from '@pertexo/workflow-model';

export const CORE_WAIT_CONFIG_SCHEMA = waitConfigSchema.meta({
  default: { durationSeconds: 60 },
});
export const CORE_WAIT_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WAIT_OUTPUT_SCHEMA = boundedNodeJsonSchema;
