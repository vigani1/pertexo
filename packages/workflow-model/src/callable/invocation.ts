import { z } from 'zod';
import type { WorkflowCallPin } from './dependencies.js';

export const workflowCallPinSchema: z.ZodType<WorkflowCallPin> = z
  .object({
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    executableChecksum: z.string().regex(/^wf:sha256:[a-f0-9]{64}$/u),
  })
  .strict();

export const workflowCallConfigSchema = z
  .object({ target: workflowCallPinSchema })
  .strict();
export type WorkflowCallConfig = Readonly<
  z.output<typeof workflowCallConfigSchema>
>;

export function isWorkflowCallDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return definition?.key === 'core.call' && definition.version === 1;
}
