import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import type { z } from 'zod';

export { waitConfigSchema as CORE_WAIT_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import type { waitConfigSchema as CORE_WAIT_CONFIG_SCHEMA } from '@pertexo/workflow-model';
export const CORE_WAIT_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WAIT_OUTPUT_SCHEMA = boundedNodeJsonSchema;

type CoreWaitConfig = Readonly<z.output<typeof CORE_WAIT_CONFIG_SCHEMA>>;
