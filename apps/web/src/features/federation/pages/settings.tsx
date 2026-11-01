import { QueryView } from '@/components/patterns/states/query-view';
import type { FederationSection } from '../search.public';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  FederationFailureReason,
  FederationSettings,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/ui/notice';
import { testFailureMessage } from '../model/test-failure';
import { federationSettingsQueryOptions } from '../data/settings.queries';
import type { FederationScope } from '../data/settings.api';
import { CreateOrganization } from '../components/organization/create';
import { OrganizationPanel } from '../components/organization/panel';
import { whoCan } from '@/features/workspaces/roles.public';
export function FederationSettingsPage({
  scope,
  workspace,
  testResult,
  testFailure,
  section = 'sign-in',
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
}: Readonly<{
  scope: FederationScope;
  workspace: AccessibleWorkspace;
  testResult?: 'passed' | 'failed' | undefined;
  testFailure?: FederationFailureReason | undefined;
  section?: FederationSection | undefined;
  navigateToProvider?: (url: string) => void;
}>) {
  const allowed = workspace.capabilities.includes('member:read');
  const settings = useQuery({
    ...federationSettingsQueryOptions(scope),
    enabled: allowed,
  });
  if (!allowed)
    return (
      <Notice>
        Only workspace {whoCan('member:read')} can read organization sign-in
        settings.
      </Notice>
    );
  const editableFor = (snapshot: FederationSettings) =>
    snapshot.canManage && snapshot.configured && workspace.status === 'active';
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Single sign-on</PageHeaderTitle>
      </PageHeader>
      <p className="text-sm text-muted-foreground">
        Let people sign in with your company’s identity provider. A verified
        domain decides how its addresses sign in; keep the owner’s recovery
        password safe for the day the provider is down.
      </p>
      {testResult === undefined ? null : (
        <Notice tone={testResult === 'passed' ? 'success' : 'warning'}>
          {testResult === 'passed'
            ? 'Provider test completed. Current domain checks determine whether SSO can be required.'
            : testFailureMessage(testFailure)}
        </Notice>
      )}
      <QueryView query={settings} resource="Sign-in settings">
        {(snapshot) => (
          <>
            {snapshot.reason === null ? null : (
              <Notice tone="warning">{snapshot.reason}</Notice>
            )}
            <OrganizationAccessNotice
              settings={snapshot}
              workspaceId={workspace.id}
            />
            {snapshot.organization === null ? (
              <CreateOrganization
                scope={scope}
                editable={editableFor(snapshot)}
              />
            ) : (
              <OrganizationPanel
                scope={scope}
                organization={snapshot.organization}
                editable={editableFor(snapshot)}
                navigateToProvider={navigateToProvider}
                workspace={workspace}
                section={section}
              />
            )}
          </>
        )}
      </QueryView>
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
