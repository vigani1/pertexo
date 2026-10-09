import {
  strongEtagSchema,
  workflowDraftResponseSchema,
  type WorkflowDraftResponse,
} from '@pertexo/contracts';

export type WorkflowDraftSnapshot = Readonly<{
  draft: WorkflowDraftResponse;
  etag: string;
}>;

export function decodeWorkflowDraftSnapshot(
  value: unknown,
  etag: string | null,
): WorkflowDraftSnapshot {
  return {
    draft: workflowDraftResponseSchema.parse(value),
    etag: strongEtagSchema.parse(etag),
  };
}
