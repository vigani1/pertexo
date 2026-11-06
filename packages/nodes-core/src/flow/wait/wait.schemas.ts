import { boundedNodeJsonSchema } from '@pertexo/node-sdk';

export { waitConfigSchema as CORE_WAIT_CONFIG_SCHEMA } from '@pertexo/workflow-model';
export const CORE_WAIT_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WAIT_OUTPUT_SCHEMA = boundedNodeJsonSchema;
