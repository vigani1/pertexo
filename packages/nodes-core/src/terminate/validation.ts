import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_TERMINATE_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_TERMINATE_INPUT_SCHEMA = boundedNodeJsonRecordSchema;
export const CORE_TERMINATE_OUTPUT_SCHEMA = boundedNodeJsonRecordSchema;
