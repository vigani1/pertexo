import {
  saveRunValuesInputSchema,
  saveRunValuesOutputSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_RUN_VALUES_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_RUN_VALUES_INPUT_SCHEMA = saveRunValuesInputSchema;
export const CORE_RUN_VALUES_OUTPUT_SCHEMA = saveRunValuesOutputSchema;
