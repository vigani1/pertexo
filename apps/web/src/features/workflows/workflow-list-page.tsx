import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/public';
import type { ApiClient } from '@/lib/api/client';
import { CreateWorkflowDialog } from './create-workflow-dialog';
import { workflowListErrorMessage } from './workflow-errors';
import { workflowsInfiniteQueryOptions } from './workflows.queries';

type WorkflowListPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function lifecycleVariant(
  status: WorkflowSummary['lifecycleStatus'],
): 'default' | 'muted' {
  return status === 'active' ? 'default' : 'muted';
}

export function WorkflowListPage({
  apiClient,
  user,
  workspace,
}: WorkflowListPageProps) {
  const workflows = useInfiniteQuery(
    workflowsInfiniteQueryOptions(apiClient, user.id, workspace.id),
  );
  const catalog = useQuery(authoringCatalogQueryOptions(apiClient, user.id));
  const connections = useQuery(
    connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
  );
  const canCreate = workspace.capabilities.includes('workflow:create');
  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-secondary">
            WORKFLOW INDEX
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Workflows
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Create and track the automations owned by {workspace.name}.
          </p>
        </div>
        {canCreate ? (
          <CreateWorkflowDialog
            apiClient={apiClient}
            userId={user.id}
            workspaceId={workspace.id}
          />
        ) : null}
      </div>

      <div className="mt-9 flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 font-mono text-[0.68rem] tracking-[0.1em] text-muted-foreground uppercase">
        {catalog.isSuccess ? (
          <>
            <span>
              {catalog.data.definitions.items.length} node definitions
            </span>
            <span>{catalog.data.integrations.items.length} integrations</span>
          </>
        ) : (
          <span>Catalog {catalog.isError ? 'unavailable' : 'loading'}</span>
        )}
        {connections.isSuccess ? (
          <span>
            {connections.data.items.length}
            {connections.data.nextCursor === null ? '' : '+'} connections
          </span>
        ) : (
          <span>
            Connections {connections.isError ? 'unavailable' : 'loading'}
          </span>
        )}
      </div>

      {workflows.isPending ? (
        <p role="status" className="py-16 text-sm text-muted-foreground">
          Loading workflows…
        </p>
      ) : workflows.isError && items.length === 0 ? (
        <Empty>
          <EmptyTitle>Workflows are unavailable</EmptyTitle>
          <EmptyDescription>
            {workflowListErrorMessage(workflows.error)}
          </EmptyDescription>
          <Button
            className="mt-6"
            type="button"
            variant="outline"
            onClick={() => void workflows.refetch()}
          >
            Try again
          </Button>
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyTitle>No workflows yet</EmptyTitle>
          <EmptyDescription>
            Create the first workflow for this workspace when you are ready to
            automate a process.
          </EmptyDescription>
          {canCreate ? (
            <div className="mt-6">
              <CreateWorkflowDialog
                apiClient={apiClient}
                userId={user.id}
                workspaceId={workspace.id}
                triggerLabel="Create the first workflow"
              />
            </div>
          ) : null}
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Activation</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((workflow) => (
                <TableRow key={workflow.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/w/$workspaceId/workflows/$workflowId"
                      params={{
                        workspaceId: workspace.id,
                        workflowId: workflow.id,
                      }}
                      className="font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {workflow.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={lifecycleVariant(workflow.lifecycleStatus)}>
                      {workflow.lifecycleStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {workflow.activationStatus}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {dateFormatter.format(new Date(workflow.updatedAt))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {workflows.hasNextPage ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={workflows.isFetchingNextPage}
                onClick={() => void workflows.fetchNextPage()}
              >
                {workflows.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {workflows.isFetchNextPageError ? (
            <p
              role="alert"
              className="mt-4 text-center text-sm text-destructive"
            >
              The next page could not be loaded. Try again.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
