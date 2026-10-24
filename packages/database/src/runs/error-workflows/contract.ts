import type { errorWorkflowDeliveryInputSchema } from './input.js';
import type { z } from 'zod';
export type ErrorWorkflowDeliveryInput = z.infer<
  typeof errorWorkflowDeliveryInputSchema
>;
export interface ErrorWorkflowStore {
  dispatch(
    input: z.infer<typeof errorWorkflowDeliveryInputSchema>,
  ): Promise<void>;
  close(): Promise<void>;
}
