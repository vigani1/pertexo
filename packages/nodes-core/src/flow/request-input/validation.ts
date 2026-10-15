import {
  inputRequestConfigSchema,
  formSubmissionSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
export const CORE_REQUEST_INPUT_CONFIG_SCHEMA = inputRequestConfigSchema;
export const CORE_REQUEST_INPUT_INPUT_SCHEMA = z.object({}).strict();
export const CORE_REQUEST_INPUT_OUTPUT_SCHEMA = z.union([
  z.object({ pending: z.literal(true) }).strict(),
  formSubmissionSchema,
]);
