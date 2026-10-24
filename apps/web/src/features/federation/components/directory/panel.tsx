import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeReadError, isAccessLost } from '@/lib/api/error-copy';
import { QueryView } from '@/components/patterns/states/query-view';
import type {
  AccessibleWorkspace,
  DirectorySettings,
  FederationSettings,
} from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { directoryQueryOptions } from '../../data/directory.queries';
import { federationSettingsQueryOptions } from '../../data/settings.queries';
import type { FederationScope } from '../../data/settings.api';
import { DirectoryCredentials } from './credentials';
import { DirectoryMappingsEditor } from './mappings';
import { DirectoryPeople } from './people';
import { DirectoryWorkspaceLinks } from './unlink';

/** Losing access hides the directory instead of showing it as stale. */
function directoryHidden(error: unknown) {
  if (!isAccessLost(error)) return undefined;
  return (
    <Notice tone="warning">
      {describeReadError(error, 'Directory settings')}
    </Notice>
  );
}

export function DirectoryPanel({
  scope,
  organization,
  workspace,
}: Readonly<{
  scope: FederationScope;
  organization: NonNullable<FederationSettings['organization']>;
  workspace: AccessibleWorkspace;
}>) {
  const query = useQuery(directoryQueryOptions(scope)),
    cache = useQueryClient();
  const editableFor = (settings: DirectorySettings) =>
    settings.canManage && workspace.status === 'active' && !query.isError;
  return (
    <QueryView
      query={query}
      resource="Directory settings"
      failure={directoryHidden}
    >
      {(settings) => (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            {settings.counts.activeUsers} active people ·{' '}
            {settings.counts.users} retained directory records ·{' '}
            {settings.counts.groups} groups
          </p>
          {!settings.canManage ? (
            <Notice>
              The control workspace owner manages provisioning. Owners of other
              linked workspaces can revoke their own workspace’s delegation
              below.
            </Notice>
          ) : null}
          <DirectoryCredentials
            scope={scope}
            settings={settings}
            editable={editableFor(settings)}
            onRefresh={() =>
              void cache.invalidateQueries({
                queryKey: federationSettingsQueryOptions(scope).queryKey,
              })
            }
          />
          <DirectoryMappingsEditor
            scope={scope}
            settings={settings}
            organization={organization}
            editable={editableFor(settings)}
          />
          <DirectoryPeople
            scope={scope}
            organization={organization}
            editable={editableFor(settings)}
          />
          <DirectoryWorkspaceLinks
            scope={scope}
            settings={settings}
            organization={organization}
            workspace={workspace}
          />
        </div>
      )}
    </QueryView>
  );
}
