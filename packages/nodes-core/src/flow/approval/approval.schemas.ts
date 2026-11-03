import {
  approvalConfigSchema,
  approvalOutputSchema,
  taskContextSchema,
  taskDetailsSchema,
  timedOutTaskOutputSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

export const CORE_APPROVAL_CONFIG_SCHEMA = approvalConfigSchema;
export const CORE_APPROVAL_INPUT_SCHEMA = z
  .object({ details: taskDetailsSchema.optional() })
  .strict();
export const CORE_APPROVAL_OUTPUT_SCHEMA = z.union([
  z
    .object({ pending: z.literal(true), context: taskContextSchema.optional() })
    .strict(),
  approvalOutputSchema,
  timedOutTaskOutputSchema,
]);
