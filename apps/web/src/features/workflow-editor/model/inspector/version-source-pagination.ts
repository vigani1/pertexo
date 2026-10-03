import type { WorkflowListResponse } from '@pertexo/contracts/schemas/workflow-authoring';

/** Keep loaded workflow pages, but never present a bounded/looped list as complete. */
export function versionSourceWorkflowPageState(
  pages: readonly WorkflowListResponse[],
  pageParams: readonly unknown[],
) {
  const cursor = pages.at(-1)?.nextCursor;
  if (cursor === undefined || cursor === null)
    return { canLoadMore: false, incomplete: false, problem: undefined };
  const repeated = pageParams.includes(cursor);
  const bounded = pages.length >= 40;
  return {
    canLoadMore: !repeated && !bounded,
    incomplete: true,
    problem: repeated
      ? 'Workflow discovery returned a repeated cursor. The list is incomplete.'
      : bounded
        ? 'Workflow discovery reached its 40-page limit. The list is incomplete.'
        : undefined,
  };
}
