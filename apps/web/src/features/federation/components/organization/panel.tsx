import { FEDERATION_LIMITS, type FederationSettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
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
}: Readonly<{
  scope: FederationScope;
  organization: NonNullable<FederationSettings['organization']>;
  editable: boolean;
  navigateToProvider: (url: string) => void;
}>) {
  return (
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
            editable={organization.domains.length < FEDERATION_LIMITS.domains}
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
  );
}
