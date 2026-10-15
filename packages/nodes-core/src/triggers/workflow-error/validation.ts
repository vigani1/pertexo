import { z } from 'zod';
import { workflowErrorInputSchema } from '@pertexo/workflow-model';

export const CORE_WORKFLOW_ERROR_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_WORKFLOW_ERROR_INPUT_SCHEMA = workflowErrorInputSchema;
export const CORE_WORKFLOW_ERROR_OUTPUT_SCHEMA = workflowErrorInputSchema;
