import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import type { WorkflowDraftRecord } from './contract.js';

/** The If-Match value of a saved draft, as this catalog reads it. */
export function draftRepresentationTag(
  workflowId: string,
  draft: WorkflowDraftRecord,
): string {
  return workflowDraftRepresentationTag({
    workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  });
}
