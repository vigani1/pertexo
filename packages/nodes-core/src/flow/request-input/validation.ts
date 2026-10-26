import {
  inputRequestConfigSchema,
  formSubmissionSchema,
  taskContextSchema,
  timedOutTaskOutputSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
export const CORE_REQUEST_INPUT_CONFIG_SCHEMA = inputRequestConfigSchema;
export const CORE_REQUEST_INPUT_INPUT_SCHEMA = taskContextSchema;
export const CORE_REQUEST_INPUT_OUTPUT_SCHEMA = z.union([
  z
    .object({ pending: z.literal(true), context: taskContextSchema.optional() })
    .strict(),
  formSubmissionSchema,
  timedOutTaskOutputSchema,
]);
