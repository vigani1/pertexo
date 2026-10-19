import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { FederationSection } from '../../search.public';
import { DirectoryPanel } from '../directory/panel';
import { FEDERATION_LIMITS, type FederationSettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import type { FederationScope } from '../../data/settings.api';
import { OrganizationWorkspaces } from './workspaces';
import { CreateDomain } from '../domains/create';
import { DomainEntry } from '../domains/entry';
import { Providers } from '../providers/list';
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
        className="flex gap-5 border-b border-border"
      >
        <Link
          to="/w/$workspaceId/settings/sso"
          params={{ workspaceId: workspace.id }}
          search={{ ssoSection: 'sign-in' }}
          aria-current={section === 'sign-in' ? 'page' : undefined}
          className={`border-b-2 pb-2 text-sm font-medium outline-none focus-ring ${section === 'sign-in' ? 'border-action text-foreground' : 'border-transparent text-muted-foreground'}`}
        >
          Sign-in providers
        </Link>
        <Link
          to="/w/$workspaceId/settings/sso"
          params={{ workspaceId: workspace.id }}
          search={{ ssoSection: 'directory' }}
          aria-current={section === 'directory' ? 'page' : undefined}
          className={`border-b-2 pb-2 text-sm font-medium outline-none focus-ring ${section === 'directory' ? 'border-action text-foreground' : 'border-transparent text-muted-foreground'}`}
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
          <SettingsSection
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
          </SettingsSection>
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
