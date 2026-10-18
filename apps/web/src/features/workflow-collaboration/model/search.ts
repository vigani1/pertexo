import { workflowIdentifierSchema } from '@pertexo/contracts';
import { isStorageText } from '@pertexo/workflow-model';
export function parseCollaborationSearch(search: Record<string, unknown>): {
  thread?: string | undefined;
  comment?: string | undefined;
  step?: string | undefined;
} {
  const thread = workflowIdentifierSchema.safeParse(search.thread);
  const comment = workflowIdentifierSchema.safeParse(search.comment);
  const step =
    typeof search.step === 'string' &&
    search.step.length > 0 &&
    search.step.length <= 128 &&
    isStorageText(search.step)
      ? search.step
      : undefined;
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
