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
  const operationQuery = useQuery({
    ...workspaceLifecycleOperationQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      operationId ?? '00000000-0000-4000-8000-000000000000',
    ),
    enabled: operationId !== undefined,
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
          Review the authoritative workspace identity and manage its lifecycle.
        </p>
      </header>

      <div className="mt-8 grid gap-6">
        <GlassSection>
          <GlassSectionHeader>
            <GlassSectionTitle>Workspace identity</GlassSectionTitle>
            <GlassSectionDescription>
              Names and slugs are read-only until the platform exposes a
              supported update contract.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent>
            <dl className="grid gap-6 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-muted-foreground uppercase">
                  Name
                </dt>
                <dd className="mt-2 break-words text-sm">{workspace.name}</dd>
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
      </div>
    </div>
  );
}
