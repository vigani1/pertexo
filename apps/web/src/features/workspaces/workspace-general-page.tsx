import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { CopyButton } from '@/components/ui/copy-button';
import type { ApiClient } from '@/lib/api/client';
import { formatDate } from '@/lib/format-time';
import { WorkspaceDangerZone } from './components/settings/workspace-danger-zone';
import { WorkspaceNameField } from './components/settings/workspace-name-field';
import { ROLE_NAMES } from './model/workspace-roles';
import {
  accessibleWorkspacesQueryOptions,
  workspaceLifecycleOperationQueryOptions,
} from './workspaces.queries';

function Fact({
  term,
  children,
}: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className="grid gap-1 border-t border-border py-3.5 first:border-t-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * Workspace settings: the name (edited in place), its address and identity,
 * then the lifecycle behind a clearly fenced danger zone.
 */
export function WorkspaceGeneralPage({
  apiClient,
  user,
  workspace,
  operationId,
  onOperationChange,
  onWorkspaceChanged,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  operationId?: string;
  onOperationChange: (operationId?: string) => void;
  onWorkspaceChanged: () => void;
}>) {
  const queryClient = useQueryClient();
  const canManage = workspace.capabilities.includes('workspace:manage');
  const operationQuery = useQuery({
    ...workspaceLifecycleOperationQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      operationId ?? '00000000-0000-4000-8000-000000000000',
    ),
    enabled: canManage && operationId !== undefined,
  });
  const handledTerminal = useRef<string | undefined>(undefined);

  // A finished lifecycle request changes the workspace itself; reload it once.
  useEffect(() => {
    const operation = operationQuery.data;
    if (
      operation === undefined ||
      (operation.status !== 'completed' && operation.status !== 'failed') ||
      handledTerminal.current === operation.id
    )
      return;
    handledTerminal.current = operation.id;
    void queryClient.invalidateQueries({
      queryKey: accessibleWorkspacesQueryOptions(apiClient, user.id).queryKey,
    });
    onWorkspaceChanged();
  }, [
    apiClient,
    onWorkspaceChanged,
    operationQuery.data,
    queryClient,
    user.id,
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader>
        <PageHeaderTitle>Settings</PageHeaderTitle>
      </PageHeader>

      <section aria-labelledby="general-title" className="flex flex-col gap-2">
        <h2 id="general-title" className="text-lg font-semibold">
          General
        </h2>
        <dl>
          <Fact term="Name">
            <WorkspaceNameField
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              onWorkspaceChanged={onWorkspaceChanged}
              onAccessLost={onWorkspaceChanged}
            />
          </Fact>
          <Fact term="URL slug">
            <CopyButton
              value={workspace.slug}
              display={workspace.slug}
              label="Copy URL slug"
            />
          </Fact>
          <Fact term="Workspace ID">
            <CopyButton
              value={workspace.id}
              display={`${workspace.id.slice(0, 8)}…`}
              label="Copy workspace ID"
            />
          </Fact>
          <Fact term="Your role">
            <span className="text-sm">{ROLE_NAMES[workspace.role]}</span>
          </Fact>
          <Fact term="Created">
            <span className="font-mono text-sm">
              {formatDate(workspace.createdAt)}
            </span>
          </Fact>
        </dl>
      </section>

      {canManage ? (
        <WorkspaceDangerZone
          apiClient={apiClient}
          workspace={workspace}
          operation={operationQuery.data}
          operationLoading={
            operationQuery.isPending && operationId !== undefined
          }
          operationReadError={operationQuery.isError}
          onOperationAccepted={(id) => {
            onOperationChange(id);
          }}
          onOperationDismissed={() => {
            onOperationChange();
          }}
          onRetryOperationRead={() => {
            void operationQuery.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
