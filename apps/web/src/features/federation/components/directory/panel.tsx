import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/error';
import type {
  AccessibleWorkspace,
  FederationSettings,
} from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { directoryQueryOptions } from '../../data/directory.queries';
import { federationSettingsQueryOptions } from '../../data/settings.queries';
import type { FederationScope } from '../../data/settings.api';
import { DirectoryCredentials } from './credentials';
import { DirectoryMappingsEditor } from './mappings';
import { DirectoryPeople } from './people';
import { DirectoryWorkspaceLinks } from './unlink';

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
  if (query.isPending) return <p role="status">Loading directory settings…</p>;
  const failure = query.isError ? (
    <Notice
      tone="warning"
      action={
        <Button
          type="button"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry directory settings
        </Button>
      }
    >
      Directory settings could not be loaded.
    </Notice>
  ) : null;
  const denied =
    isApiError(query.error) &&
    [401, 403, 404].includes(query.error.status ?? 0);
  if (query.data === undefined || denied) return failure;
  const settings = query.data,
    editable =
      settings.canManage && workspace.status === 'active' && !query.isError;
  return (
    <div className="space-y-6">
      {failure}
      <p className="text-sm text-muted-foreground">
        {settings.counts.activeUsers} active people · {settings.counts.users}{' '}
        retained directory records · {settings.counts.groups} groups
      </p>
      {!settings.canManage ? (
        <Notice>
          The control workspace owner manages provisioning. Owners of other
          linked workspaces can revoke their own workspace’s delegation below.
        </Notice>
      ) : null}
      <DirectoryCredentials
        scope={scope}
        settings={settings}
        editable={editable}
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
        editable={editable}
      />
      <DirectoryPeople
        scope={scope}
        organization={organization}
        editable={editable}
      />
      <DirectoryWorkspaceLinks
        scope={scope}
        settings={settings}
        organization={organization}
        workspace={workspace}
      />
    </div>
  );
}
