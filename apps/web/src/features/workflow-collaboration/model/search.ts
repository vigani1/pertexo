import { workflowIdentifierSchema } from '@pertexo/contracts';
import { isStorageText } from '@pertexo/workflow-model';
export function parseCollaborationSearch(search: Record<string, unknown>): {
  thread?: string | undefined;
  comment?: string | undefined;
  step?: string | undefined;
} {
  const thread = workflowIdentifierSchema.safeParse(search.thread);
  const comment = workflowIdentifierSchema.safeParse(search.comment);
  const rawStep = search.step;
  const hasValidStep =
    typeof rawStep === 'string' &&
    rawStep.length > 0 &&
    rawStep.length <= 128 &&
    isStorageText(rawStep);
  const step = hasValidStep ? rawStep : undefined;
  return {
    ...(thread.success
      ? {
          thread: thread.data,
          ...(comment.success ? { comment: comment.data } : {}),
        }
      : {}),
    ...(step === undefined ? {} : { step }),
  };
}
