import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_SET_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_SET_INPUT_SCHEMA = boundedNodeJsonRecordSchema;
export const CORE_SET_OUTPUT_SCHEMA = boundedNodeJsonRecordSchema;
