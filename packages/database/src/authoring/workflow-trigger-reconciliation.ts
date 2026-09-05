import { z } from 'zod';

const uuidSchema = z.uuid();
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

export function reconcileWorkflowTriggersPayload(
  input: Readonly<{
    outboxEventId: string;
    publishedVersionId: string;
    traceparent?: string;
    workflowId: string;
    workspaceId: string;
  }>,
): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: uuidSchema.parse(input.workspaceId),
    outboxEventId: uuidSchema.parse(input.outboxEventId),
    workflowId: uuidSchema.parse(input.workflowId),
    publishedVersionId: uuidSchema.parse(input.publishedVersionId),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: traceparentSchema.parse(input.traceparent) }),
  });
}
