import { z } from 'zod';

export const errorWorkflowDeliveryInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceRunId: z.uuid(),
    outboxEventId: z.uuid(),
    payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
    signal: z.instanceof(AbortSignal),
    traceparent: z.string().optional(),
  })
  .strict();
export class ErrorWorkflowDeliveryMismatchError extends Error {
  public override readonly name = 'ErrorWorkflowDeliveryMismatchError';
}
export class ErrorWorkflowVersionUnavailableError extends Error {
  public override readonly name = 'ErrorWorkflowVersionUnavailableError';
}
export type ErrorWorkflowDeliveryInput = z.infer<
  typeof errorWorkflowDeliveryInputSchema
>;
export interface ErrorWorkflowStore {
  dispatch(
    input: z.infer<typeof errorWorkflowDeliveryInputSchema>,
  ): Promise<void>;
  close(): Promise<void>;
}
