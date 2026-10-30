import {
  workflowCommentStepIdSchema,
  workflowIdentifierSchema,
} from '@pertexo/contracts';
export function parseCollaborationSearch(search: Record<string, unknown>): {
  thread?: string | undefined;
  comment?: string | undefined;
  step?: string | undefined;
} {
  const thread = workflowIdentifierSchema.safeParse(search.thread);
  const comment = workflowIdentifierSchema.safeParse(search.comment);
  const step = workflowCommentStepIdSchema.safeParse(search.step);
  return {
    ...(thread.success
      ? {
          thread: thread.data,
          ...(comment.success ? { comment: comment.data } : {}),
        }
      : {}),
    ...(step.success ? { step: step.data } : {}),
  };
}
