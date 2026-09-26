import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { CopyButton } from '@/components/ui/copy-button';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { SettingsSection } from '@/components/patterns/settings-section';
import { cn } from '@/lib/utils';
import {
  DangerZone,
  WorkspaceLifecycleControls,
} from './components/settings/workspace-danger-zone';
import { WorkspaceLeave } from './components/settings/workspace-leave';
import { WorkspaceNameField } from './components/settings/workspace-name-field';
import { WorkspaceAccess } from './components/settings/workspace-access';
import { WorkspaceOverview } from './components/settings/workspace-overview';
import { WorkspaceMark } from './components/shell/workspace-mark';
import { ROLE_SUMMARIES, withArticle } from './model/workspace-roles';
import {
  accessibleWorkspacesQueryOptions,
  workspaceLifecycleOperationQueryOptions,
} from './workspaces.queries';

function Fact({
  term,
  className,
  children,
}: Readonly<{ term: string; className?: string; children: ReactNode }>) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Workspace settings: its identity (the name edited in place), what lives in
 * it, what your role lets you do, then deleting and leaving behind a clearly
 * fenced danger zone.
 */
export function WorkspaceGeneralPage({
  apiClient,
  user,
  workspace,
  operationId,
  onOperationChange,
  onWorkspaceChanged,
  onLeft,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  operationId?: string;
  onOperationChange: (operationId?: string) => void;
  onWorkspaceChanged: () => void;
  /** The person left; their sessions have ended. */
  onLeft: () => void;
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
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Settings</PageHeaderTitle>
      </PageHeader>

      <div className="flex flex-col">
        <SettingsSection
          title="Workspace"
          description="How this workspace is known, with the slug and ID that support and the API ask for."
        >
          <div className="flex min-w-0 items-center gap-4">
            <WorkspaceMark
              name={workspace.name}
              className="size-14 rounded-xl text-lg"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <WorkspaceNameField
                apiClient={apiClient}
                userId={user.id}
                workspace={workspace}
                nameClassName="font-display text-2xl leading-tight [--display-optical-size:24] [--display-width:84%]"
                onWorkspaceChanged={onWorkspaceChanged}
                onAccessLost={onWorkspaceChanged}
              />
              <span className="text-xs text-muted-foreground">
                You’re {withArticle(workspace.role)} here.
              </span>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
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
            <Fact term="Created" className="col-span-2 sm:col-span-1">
              <time dateTime={workspace.createdAt}>
                {formatRelativeTime(workspace.createdAt)}
              </time>
              <span className="block font-mono text-[0.72rem] text-subtle-foreground">
                {formatDateTime(workspace.createdAt)}
              </span>
            </Fact>
          </dl>
        </SettingsSection>

        <SettingsSection
          title="At a glance"
          description="What lives in this workspace. Each one opens its page."
        >
          <WorkspaceOverview
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
          />
        </SettingsSection>

        <SettingsSection
          title="Your access"
          description={`You’re ${withArticle(workspace.role)}. ${ROLE_SUMMARIES[workspace.role]}`}
        >
          <WorkspaceAccess workspace={workspace} />
        </SettingsSection>

        <DangerZone>
          {canManage ? (
            <WorkspaceLifecycleControls
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
          <WorkspaceLeave
            apiClient={apiClient}
            workspace={workspace}
            onLeft={onLeft}
          />
        </DangerZone>
      </div>
    </div>
  );
}
