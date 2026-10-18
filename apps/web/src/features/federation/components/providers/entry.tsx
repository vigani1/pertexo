import type { FederationSettings } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import type { FederationScope } from '../../data/settings.api';
import { TestProvider } from './test';
type Organization = NonNullable<FederationSettings['organization']>;
type Provider = Organization['providers'][number];
function trustDescription(provider: Provider) {
  if (provider.kind === 'oidc')
    return `OIDC · Client secret ${provider.secretConfigured ? 'configured' : 'missing'}`;
  const count = provider.configuration.certificates.length;
  return `SAML · ${String(count)} pinned signing certificate${count === 1 ? '' : 's'}`;
}
export function ProviderEntry({
  scope,
  organization,
  provider,
  locked,
  editable,
  onEdit,
  onRemove,
  navigateToProvider,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  provider: Provider;
  locked: boolean;
  editable: boolean;
  onEdit: (provider: Provider) => void;
  onRemove: (provider: Provider) => void;
  navigateToProvider: (url: string) => void;
}>) {
  return (
    <li className="space-y-4 py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{provider.name}</h3>
        <Status tone={provider.enabled ? 'success' : 'neutral'}>
          {provider.enabled ? 'Enabled' : 'Off'}
        </Status>
      </div>
      <p className="break-all text-sm text-muted-foreground">
        {provider.issuer}
      </p>
      <p className="text-xs text-muted-foreground">
        New accounts {provider.configuration.jitEnabled ? 'allowed' : 'off'} ·{' '}
        {trustDescription(provider)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            onEdit(provider);
          }}
        >
          Edit provider
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            onRemove(provider);
          }}
        >
          Remove provider
        </Button>
      </div>
      <TestProvider
        scope={scope}
        organization={organization}
        provider={provider}
        editable={editable}
        navigateToProvider={navigateToProvider}
      />
    </li>
  );
}
