import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

// Endpoint keys and signing secrets belong to materialized trigger state.
export const CORE_WEBHOOK_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_WEBHOOK_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_WEBHOOK_OUTPUT_SCHEMA = boundedNodeJsonSchema;
