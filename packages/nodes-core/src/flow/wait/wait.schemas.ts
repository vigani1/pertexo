import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { waitConfigSchema } from '@pertexo/workflow-model';

const DEFAULT_WAIT_SECONDS = 60;

export const CORE_WAIT_CONFIG_SCHEMA = waitConfigSchema.meta({
  default: { durationSeconds: DEFAULT_WAIT_SECONDS },
});
export const CORE_WAIT_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WAIT_OUTPUT_SCHEMA = boundedNodeJsonSchema;
