import {
  approvalConfigSchema,
  approvalOutputSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

export const CORE_APPROVAL_CONFIG_SCHEMA = approvalConfigSchema;
export const CORE_APPROVAL_INPUT_SCHEMA = z.object({}).strict();
export const CORE_APPROVAL_OUTPUT_SCHEMA = z.union([
  z.object({ pending: z.literal(true) }).strict(),
  approvalOutputSchema,
]);
