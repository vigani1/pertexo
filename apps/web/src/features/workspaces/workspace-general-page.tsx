import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Badge } from '@/components/ui/badge';
import type { ApiClient } from '@/lib/api/client';
import { WorkspaceLifecycleSection } from './components/settings/workspace-lifecycle-section';
import { WorkspaceNameSection } from './components/settings/workspace-name-section';
import { WorkspaceSettingsNavigation } from './components/settings/workspace-settings-navigation';
import {
  accessibleWorkspacesQueryOptions,
  workspaceLifecycleOperationQueryOptions,
} from './workspaces.queries';

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
    <div>
      <WorkspaceSettingsNavigation workspace={workspace} />
      <header>
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          WORKSPACE CONTROL
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          General
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Review workspace details and manage its lifecycle.
        </p>
      </header>

      <div className="mt-8 grid gap-6">
        <WorkspaceNameSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          onWorkspaceChanged={onWorkspaceChanged}
          onAccessLost={onWorkspaceChanged}
        />
        <GlassSection>
          <GlassSectionHeader>
            <GlassSectionTitle>Workspace identity</GlassSectionTitle>
            <GlassSectionDescription>
              The slug is a stable identifier and remains read-only.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent>
            <dl className="grid gap-6 sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground uppercase">
                  Name
                </dt>
                <dd className="mt-2 break-all text-sm">{workspace.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground uppercase">
                  Slug
                </dt>
                <dd className="mt-2 break-all font-mono text-sm">
                  {workspace.slug}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground uppercase">
                  Status
                </dt>
                <dd className="mt-2">
                  <Badge
                    variant={
                      workspace.status === 'pending_deletion'
                        ? 'destructive'
                        : workspace.status === 'suspended'
                          ? 'muted'
                          : 'secondary'
                    }
                  >
                    {workspace.status.replace('_', ' ')}
                  </Badge>
                </dd>
              </div>
            </dl>
          </GlassSectionContent>
        </GlassSection>

        {canManage ? (
          <WorkspaceLifecycleSection
            apiClient={apiClient}
            workspace={workspace}
            {...(operationQuery.data === undefined
              ? {}
              : { operation: operationQuery.data })}
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
    </div>
  );
}
