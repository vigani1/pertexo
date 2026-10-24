import { Link } from '@tanstack/react-router';
import { promotionSearch } from '@/features/workflow-promotions/search.public';
import { XIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PROMOTION_LIMITS } from '@pertexo/contracts';
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
import { cn } from '@/lib/utils';
import {
  ROW_REVEAL_CLASS,
  type WorkflowRowActions,
} from '../list/workflow-row-actions';
import { WorkflowRows, WorkflowListFooter } from '../list/workflow-rows';
import { canEditOrganization } from './editing';
import { WorkflowOrganizationDialog } from './dialog';
import { WorkflowOrganizationRowMenu } from './row-menu';

/** Selection is explicit, ordered and bounded to loaded rows in one URL scope. */
type WorkflowOrganizedResultsProps = Readonly<{
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
}>;

export function WorkflowOrganizedResults({
  apiClient,
  userId,
  workspace,
  items,
  workflows,
  actions,
}: WorkflowOrganizedResultsProps) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editing, setEditing] =
    useState<readonly WorkflowOrganizationProjectionResponse[]>();
  const currentSelected = selected.flatMap((id) => {
    const item = items.find((entry) => entry.workflow.id === id);
    return item === undefined ? [] : [item];
  });
  const canEdit = canEditOrganization(workspace, [], 'move');
  const byId = new Map(items.map((item) => [item.workflow.id, item]));
  function selectionControl(id: string): ReactNode {
    const item = byId.get(id);
    if (item === undefined) return null;
    const allowed = canEditOrganization(workspace, [item], 'move');
    if (!allowed) return null;
    return (
      <Checkbox
        aria-label={`Select ${item.workflow.name}`}
        className={cn(
          // A bead: a hollow loop that ties into a knot when picked, with a
          // 32px (44px on touch) hit area around it.
          'relative size-4 rounded-full [&_svg]:size-2.5 after:absolute after:-inset-2 pointer-coarse:after:-inset-3.5',
          currentSelected.length === 0 && ROW_REVEAL_CLASS,
        )}
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
    );
  }
  function tags(id: string): ReactNode {
    const item = byId.get(id);
    if (item === undefined || item.organization.tags.length === 0) return null;
    return (
      <span className="text-xs text-muted-foreground">
        {item.organization.tags.map((tag) => tag.key).join(' · ')}
      </span>
    );
  }
  return (
    <section aria-label="Workspace workflows" className="flex flex-col gap-4">
      {/* Floats above the list instead of pushing it down, so picking the
          first workflow never moves the row under the pointer. */}
      {canEdit && currentSelected.length > 0 ? (
        <SelectedWorkflowTools
          workspace={workspace}
          selected={currentSelected}
          disabled={editing !== undefined}
          onOrganize={() => {
            setEditing(currentSelected);
          }}
          onClear={() => {
            setSelected([]);
          }}
        />
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
          {...(canEdit ? { rowSelection: selectionControl } : {})}
          rowTags={tags}
          rowMenu={(id, runnable) => {
            const item = byId.get(id);
            if (item === undefined) return null;
            const allowed = canEditOrganization(workspace, [item], 'move');
            return (
              <WorkflowOrganizationRowMenu
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                workflow={item}
                actions={actions}
                runnable={runnable}
                disabled={editing !== undefined}
                {...(allowed
                  ? {
                      onOrganize: () => {
                        setEditing([item]);
                      },
                    }
                  : {})}
              />
            );
          }}
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

function SelectedWorkflowTools({
  workspace,
  selected,
  disabled,
  onOrganize,
  onClear,
}: Readonly<{
  workspace: AccessibleWorkspace;
  selected: readonly WorkflowOrganizationProjectionResponse[];
  disabled: boolean;
  onOrganize: () => void;
  onClear: () => void;
}>) {
  return (
    <div
      role="toolbar"
      aria-label="Selected workflows"
      className="lens fixed bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.75rem)] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl py-1.5 pr-1.5 pl-3.5 motion-safe:animate-[rise_0.25s_var(--ease-unspool)] md:bottom-6"
    >
      <span
        aria-hidden="true"
        className="mr-1 size-2.5 shrink-0 rounded-full bg-action shadow-[0_0_0_3px_color-mix(in_srgb,var(--action)_18%,transparent)]"
      />
      <span
        className="mr-2 text-sm whitespace-nowrap text-foreground"
        aria-live="polite"
      >
        {String(selected.length)} selected
        {selected.length >= 50 ? (
          <span className="text-muted-foreground"> · the most at once</span>
        ) : null}
      </span>
      <Button
        variant="default"
        size="sm"
        aria-label="Organize selected…"
        disabled={disabled}
        onClick={() => {
          onOrganize();
        }}
      >
        Organize…
      </Button>
      {workspace.capabilities.includes('workflow:update') &&
      selected.length <= PROMOTION_LIMITS.workflows &&
      selected.every((item) => item.workflow.publishedVersionId !== null) ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              to="/w/$workspaceId/settings/promotion"
              params={{ workspaceId: workspace.id }}
              search={promotionSearch(
                selected.flatMap((item) =>
                  item.workflow.publishedVersionId === null
                    ? []
                    : [
                        {
                          workflowId: item.workflow.id,
                          versionId: item.workflow.publishedVersionId,
                        },
                      ],
                ),
              )}
            />
          }
        >
          Promote…
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        title="Clear selection"
        disabled={disabled}
        onClick={() => {
          onClear();
        }}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
