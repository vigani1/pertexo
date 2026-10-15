import { z } from 'zod';
import { isWorkflowTriggerKey } from '../graph/triggers.js';

const targetGraphSchema = z.object({
  nodes: z.array(
    z.object({
      definition: z.object({ key: z.string(), version: z.number().int() }),
      disabled: z.boolean().optional(),
    }),
  ),
});

/** Published target readiness, shared by selection and delayed admission. */
export function isWorkflowErrorTarget(graph: unknown): boolean {
  const parsed = targetGraphSchema.safeParse(graph);
  if (!parsed.success) return false;
  const triggers = parsed.data.nodes.filter((node) =>
    isWorkflowTriggerKey(node.definition.key),
  );
  const entry = triggers[0];
  return (
    triggers.length === 1 &&
    entry?.definition.key === 'core.workflow_error' &&
    entry.definition.version === 1 &&
    entry.disabled !== true
  );
}
