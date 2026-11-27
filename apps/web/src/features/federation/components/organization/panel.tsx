import { tabTileClass } from '@/components/ui/tabs';
import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { FederationSection } from '../../model/federation-search';
import { DirectoryPanel } from '../directory/panel';
import type { FederationSettings } from '@pertexo/contracts';
import { SettingRow } from '@/components/patterns/settings/row';
import type { FederationScope } from '../../data/federation-settings.api';
import { OrganizationWorkspaces } from './workspaces';
import { CreateDomain } from '../domains/create';
import { DomainEntry } from '../domains/entry';
import { Providers } from '../providers/provider-list';
export function OrganizationPanel({
  scope,
  organization,
  editable,
  navigateToProvider,
  workspace,
  section,
}: Readonly<{
  scope: FederationScope;
  organization: NonNullable<FederationSettings['organization']>;
  editable: boolean;
  navigateToProvider: (url: string) => void;
  workspace: AccessibleWorkspace;
  section: FederationSection;
}>) {
  return (
    <>
      <nav
        aria-label="Single sign-on sections"
        className="flex flex-wrap gap-1"
      >
        <Link
          to="/w/$workspaceId/settings/sso"
          params={{ workspaceId: workspace.id }}
          search={{ ssoSection: 'sign-in' }}
          activeOptions={{
            exact: true,
            includeSearch: true,
            explicitUndefined: true,
          }}
          activeProps={{
            'aria-current': section === 'sign-in' ? 'page' : undefined,
          }}
          inactiveProps={{
            'aria-current': section === 'sign-in' ? 'page' : undefined,
          }}
          className={tabTileClass}
        >
          Sign-in providers
        </Link>
        <Link
          to="/w/$workspaceId/settings/sso"
          params={{ workspaceId: workspace.id }}
          search={{ ssoSection: 'directory' }}
          activeOptions={{
            exact: true,
            includeSearch: true,
            explicitUndefined: true,
          }}
          className={tabTileClass}
        >
          Directory
        </Link>
      </nav>
      {section === 'directory' ? (
        <DirectoryPanel
          scope={scope}
          organization={organization}
          workspace={workspace}
        />
      ) : (
        <>
          <OrganizationWorkspaces
            scope={scope}
            organization={organization}
            editable={editable}
          />
          <SettingRow
            layout="section"
            title="Verified domains"
            description="DNS ownership is required before a domain can use organization sign-in. Enable and test a provider before requiring SSO."
          >
            <ul>
              {organization.domains.map((domain) => (
                <DomainEntry
                  key={domain.id}
                  scope={scope}
                  organization={organization}
                  domain={domain}
                  editable={editable}
                />
              ))}
            </ul>
            {editable ? (
              <CreateDomain
                scope={scope}
                revision={organization.revision}
                editable={
                  organization.domains.length < FEDERATION_LIMITS.domains
                }
              />
            ) : null}
          </SettingRow>
          <Providers
            scope={scope}
            organization={organization}
            editable={editable}
            navigateToProvider={navigateToProvider}
          />
        </>
      )}
    </>
  );
}
