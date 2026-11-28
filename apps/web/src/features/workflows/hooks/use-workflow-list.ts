import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import type { WorkflowListSearch } from '../model/list-view';
import { useOrganizationList } from './organization/use-organization-list';

/** Which of the list's four states is on screen. */
function listState({
  pending,
  loaded,
  empty,
}: Readonly<{ pending: boolean; loaded: boolean; empty: boolean }>):
  'loading' | 'failed' | 'empty' | 'results' {
  if (pending) return 'loading';
  if (!loaded) return 'failed';
  return empty ? 'empty' : 'results';
}

type ListScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>;

/**
 * The list's pages in the chosen order and which of the list's states is on
 * screen. Changing the sort keeps the current rows until the re-sorted pages
 * land.
 */
export function useWorkflowList(
  { apiClient, userId, workspace }: ListScope,
  search: WorkflowListSearch,
) {
  const workflows = useOrganizationList(
    apiClient,
    userId,
    workspace.id,
    search,
  );
  const organizations = (
    workflows.data?.pages.flatMap((page) => page.organizations) ?? []
  ).filter(
    ({ workflow }) =>
      search.publication === undefined ||
      (search.publication === 'drafts'
        ? workflow.publishedVersionId === null
        : workflow.publishedVersionId !== null),
  );
  const items = organizations.map(({ workflow }) => workflow);
  const empty = workflows.data !== undefined && items.length === 0;
  return {
    workflows,
    items,
    empty,
    shown: listState({
      pending: workflows.isPending,
      loaded: workflows.data !== undefined,
      empty,
    }),
    organizations,
  } as const;
}
