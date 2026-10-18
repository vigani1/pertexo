import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  FederationSettings,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { federationSettingsQueryOptions } from '../data/settings.queries';
import type { FederationScope } from '../data/settings.api';
import { CreateOrganization } from '../components/organization/create';
import { OrganizationPanel } from '../components/organization/panel';
export function FederationSettingsPage({
  scope,
  workspace,
  testResult,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
}: Readonly<{
  scope: FederationScope;
  workspace: AccessibleWorkspace;
  testResult?: 'passed' | 'failed' | undefined;
  navigateToProvider?: (url: string) => void;
}>) {
  const allowed = workspace.capabilities.includes('workspace:manage');
  const settings = useQuery({
    ...federationSettingsQueryOptions(scope),
    enabled: allowed,
  });
  if (!allowed)
    return (
      <Notice>
        Only workspace owners and admins can read organization sign-in settings.
      </Notice>
    );
  const snapshot = settings.data,
    editable =
      snapshot?.canManage === true &&
      snapshot.configured &&
      workspace.status === 'active';
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Single sign-on</PageHeaderTitle>
      </PageHeader>
      <p className="text-sm text-muted-foreground">
        Verified domains set account sign-in policy across this install. Linked
        workspaces control which memberships new SSO accounts receive. Keep the
        recovery owner password available during an identity provider outage.
      </p>
      {settings.isPending ? (
        <p role="status">Loading sign-in settings…</p>
      ) : null}
      {settings.isError ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void settings.refetch()}
            >
              Retry settings
            </Button>
          }
        >
          Sign-in settings could not be loaded.
        </Notice>
      ) : null}
      {snapshot?.reason === null || snapshot?.reason === undefined ? null : (
        <Notice tone="warning">{snapshot.reason}</Notice>
      )}
      {testResult === undefined ? null : (
        <Notice tone={testResult === 'passed' ? 'success' : 'warning'}>
          {testResult === 'passed'
            ? 'Provider test completed. Current domain checks determine whether SSO can be required.'
            : 'Provider test did not finish. Check the issuer, client credentials, callback URI and domain, then try again.'}
        </Notice>
      )}
      {snapshot === undefined ? null : (
        <>
          <OrganizationAccessNotice
            settings={snapshot}
            workspaceId={workspace.id}
          />
          {snapshot.organization === null ? (
            <CreateOrganization scope={scope} editable={editable} />
          ) : (
            <OrganizationPanel
              scope={scope}
              organization={snapshot.organization}
              editable={editable}
              navigateToProvider={navigateToProvider}
            />
          )}
        </>
      )}
    </div>
  );
}

function OrganizationAccessNotice({
  settings,
  workspaceId,
}: Readonly<{ settings: FederationSettings; workspaceId: string }>) {
  if (settings.canManage || !settings.configured) return null;
  const controlWorkspaceId = settings.organization?.controlWorkspaceId;
  return (
    <Notice>
      Only the current control workspace owner can change organization sign-in.
      {controlWorkspaceId === undefined ||
      controlWorkspaceId === workspaceId ? null : (
        <>
          {' '}
          <Link
            className="inline-link"
            to="/w/$workspaceId/settings/sso"
            params={{ workspaceId: controlWorkspaceId }}
          >
            Open control workspace
          </Link>
        </>
      )}
    </Notice>
  );
}
