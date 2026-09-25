import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { RunFilters } from './components/run-filters/run-filters';
import {
  NoWorkflowRunsYet,
  RunsForbidden,
} from './components/run-list/run-list-states';
import { RunResults } from './components/run-list/run-results';
import { RunsToolbar } from './components/run-list/runs-toolbar';
import {
  filtersFromSearch,
  withRunView,
  type WorkflowRunSearch,
} from './model/run-search';
import { useRunHistory } from './use-run-history';

/**
 * A workflow's Runs tab: the same list as the Runs page, fixed to this
 * workflow, so it has no workflow column or filter.
 */
export function WorkflowRunsPage({
  apiClient,
  user,
  workspace,
  workflowId,
  search,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  search: WorkflowRunSearch;
  onSearchChange: (search: WorkflowRunSearch) => void;
}>) {
  const [live, setLive] = useState(false);
  const { query, runs, canRead } = useRunHistory({
    apiClient,
    userId: user.id,
    workspace,
    filters: { ...filtersFromSearch(search), workflowId },
    live,
  });
  if (!canRead) return <RunsForbidden role={workspace.role} />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">Runs</h2>
        <div className="flex flex-wrap items-center gap-2">
          <RunsToolbar
            live={live}
            onLiveChange={setLive}
            view={search.view ?? 'list'}
            onViewChange={(view) => {
              onSearchChange(withRunView(search, view));
            }}
          />
        </div>
      </div>
      <RunFilters search={search} onSearchChange={onSearchChange} />
      <RunResults
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        search={search}
        onSearchChange={onSearchChange}
        query={query}
        runs={runs}
        variant="workflow"
        noRuns={
          <NoWorkflowRunsYet
            workspaceId={workspace.id}
            workflowId={workflowId}
          />
        }
      />
    </div>
  );
}
