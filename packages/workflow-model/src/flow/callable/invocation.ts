import { workflowExecutableChecksumSchema } from '../../graph/executable-checksum.js';
import { z } from 'zod';
import type { WorkflowCallPin } from './dependencies.js';

export const WORKFLOW_CALL = Object.freeze({ key: 'core.call', version: 1 });

const workflowCallPinSchema: z.ZodType<WorkflowCallPin> = z
  .object({
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    executableChecksum: workflowExecutableChecksumSchema,
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
  return (
    definition?.key === WORKFLOW_CALL.key &&
    definition.version === WORKFLOW_CALL.version
  );
}
