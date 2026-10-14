import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_MANUAL_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_MANUAL_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_MANUAL_OUTPUT_SCHEMA = boundedNodeJsonSchema;
