import { useState, type ReactNode } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
  WorkflowListResponse,
} from '@pertexo/contracts';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { StaleLine } from '@/components/patterns/states/stale-line';
import type { ApiClient } from '@/lib/api/client';
import type { WorkflowRowActions } from '../list/workflow-row-actions';
import { WorkflowRows, WorkflowListFooter } from '../list/workflow-rows';
import { WorkflowOrganizationDialog } from './dialog';
import { WorkflowFavoriteButton } from './favorites/button';

/** Selection is explicit, ordered and bounded to loaded rows in one URL scope. */
export function WorkflowOrganizedResults({
  apiClient,
  userId,
  workspace,
  items,
  workflows,
  actions,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  items: readonly WorkflowOrganizationProjectionResponse[];
  workflows: Pick<
    UseInfiniteQueryResult<InfiniteData<WorkflowListResponse>>,
    | 'isRefetchError'
    | 'dataUpdatedAt'
    | 'isFetching'
    | 'refetch'
    | 'hasNextPage'
    | 'isFetchingNextPage'
    | 'isFetchNextPageError'
    | 'fetchNextPage'
  >;
  actions: WorkflowRowActions;
}>) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editing, setEditing] =
    useState<readonly WorkflowOrganizationProjectionResponse[]>();
  const currentSelected = selected.flatMap((id) => {
    const item = items.find((entry) => entry.workflow.id === id);
    return item === undefined ? [] : [item];
  });
  const canEdit =
    workspace.role === 'owner' ||
    workspace.role === 'admin' ||
    workspace.role === 'builder';
  const byId = new Map(items.map((item) => [item.workflow.id, item]));
  function controls(id: string): ReactNode {
    const item = byId.get(id);
    if (item === undefined) return null;
    const allowed =
      canEdit &&
      (item.workflow.lifecycleStatus !== 'archived' ||
        workspace.role !== 'builder');
    return (
      <div className="relative z-10 flex flex-wrap items-center gap-2">
        {allowed ? (
          <Checkbox
            aria-label={`Select ${item.workflow.name}`}
            checked={selected.includes(id)}
            disabled={
              editing !== undefined ||
              (!selected.includes(id) && selected.length >= 50)
            }
            onCheckedChange={(checked) => {
              setSelected((previous) =>
                checked
                  ? [...previous.filter((entry) => entry !== id), id]
                  : previous.filter((entry) => entry !== id),
              );
            }}
          />
        ) : null}
        <WorkflowFavoriteButton
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={item}
          disabled={editing !== undefined}
        />
        {allowed ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing([item]);
            }}
            disabled={editing !== undefined}
          >
            Organize…
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {item.organization.tags.map((tag) => tag.key).join(' · ')}
        </span>
      </div>
    );
  }
  return (
    <section aria-label="Workspace workflows" className="flex flex-col gap-4">
      {canEdit ? (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Selected workflows"
        >
          <span className="text-sm text-muted-foreground">
            {String(currentSelected.length)} selected · up to 50 loaded
            workflows
          </span>
          <Button
            variant="outline"
            disabled={currentSelected.length === 0 || editing !== undefined}
            onClick={() => {
              setEditing(currentSelected);
            }}
          >
            Organize selected…
          </Button>
          <Button
            variant="ghost"
            disabled={selected.length === 0 || editing !== undefined}
            onClick={() => {
              setSelected([]);
            }}
          >
            Clear selection
          </Button>
        </div>
      ) : null}
      {workflows.isRefetchError ? (
        <StaleLine
          updatedAt={workflows.dataUpdatedAt}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : null}
      {items.length === 0 ? (
        <Empty>
          <EmptyTitle>No workflows match these filters</EmptyTitle>
          <EmptyDescription>
            Change the filters above, or create a workflow. Folder filters
            include this folder only, not its descendants.
          </EmptyDescription>
        </Empty>
      ) : (
        <WorkflowRows
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflows={items.map((item) => item.workflow)}
          actions={actions}
          organizationControls={controls}
        />
      )}
      <WorkflowListFooter
        hasNextPage={workflows.hasNextPage}
        loadingNextPage={workflows.isFetchingNextPage}
        nextPageError={workflows.isFetchNextPageError}
        filtering={false}
        loadedCount={items.length}
        onLoadMore={() => void workflows.fetchNextPage()}
      />
      {editing === undefined ? null : (
        <WorkflowOrganizationDialog
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflows={editing}
          onClose={() => {
            setEditing(undefined);
            setSelected([]);
          }}
        />
      )}
    </section>
  );
}
