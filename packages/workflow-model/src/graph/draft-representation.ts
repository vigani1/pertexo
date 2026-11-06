import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../values/json/canonical.js';
import { parseWorkflowGraphDraft } from './validation/preflight.js';
export type WorkflowDraftRepresentationTag = `"draft.${string}"`;

export function workflowDraftRepresentationTag(input: {
  readonly workflowId: string;
  readonly revision: number;
  readonly graph: unknown;
  readonly compatibilityFingerprint: string;
}): WorkflowDraftRepresentationTag {
  const workflowId = z.uuid().parse(input.workflowId);
  const revision = z.number().int().positive().parse(input.revision);
  const graph = parseWorkflowGraphDraft(input.graph);
  const compatibilityFingerprint = z
    .string()
    .min(1)
    .max(256)
    .parse(input.compatibilityFingerprint);
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.draft-representation',
        workflowId,
        revision,
        graph,
        compatibilityFingerprint,
      }),
    )
    .digest('base64url');
  return `"draft.${digest}"`;
}
