import { useState } from 'react';
import { FEDERATION_LIMITS, type FederationSettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Status } from '@/components/ui/status';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
import { ProviderForm } from './form';
import { TestProvider } from './test';
type Organization = NonNullable<FederationSettings['organization']>;
export function Providers({
  scope,
  organization,
  editable,
  navigateToProvider,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  editable: boolean;
  navigateToProvider: (url: string) => void;
}>) {
  const [editing, setEditing] = useState<
    'new' | Organization['providers'][number]
  >();
  const [removing, setRemoving] = useState<Organization['providers'][number]>();
  const command = useFederationCommand(scope, () => {
    setRemoving(undefined);
  });
  const locked = !editable || command.pending || command.uncertain;
  const callback = new URL(
    '/v1/auth/federation/oidc/callback',
    window.location.origin,
  ).toString();
  const edited = organization.providers.find(
    (provider) => provider.id === (editing === 'new' ? undefined : editing?.id),
  );
  return (
    <SettingsSection
      title="Identity providers"
      description="Configure a public HTTPS OIDC issuer. Password/social sign-in stays available until a verified domain requires SSO."
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Register this exact redirect URI at your identity provider:
        </p>
        <div className="flex min-w-0 items-start gap-2">
          <code className="min-w-0 break-all text-xs">{callback}</code>
          <CopyButton value={callback} label="Copy OIDC redirect URI" />
        </div>
      </div>
      {organization.providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No organization providers configured.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {organization.providers.map((provider) => (
            <li key={provider.id} className="space-y-4 py-5">
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
                New accounts{' '}
                {provider.configuration.jitEnabled ? 'allowed' : 'off'} · Client
                secret {provider.secretConfigured ? 'configured' : 'missing'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    setEditing(provider);
                  }}
                >
                  Edit provider
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    setRemoving(provider);
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
          ))}
        </ul>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={
            locked ||
            organization.providers.length >= FEDERATION_LIMITS.providers
          }
          onClick={() => {
            setEditing('new');
          }}
        >
          Add OIDC provider
        </Button>
      </div>
      {removing === undefined ? <CommandFeedback command={command} /> : null}
      {editing === undefined ? null : (
        <ProviderForm
          key={editing === 'new' ? 'new' : editing.id}
          scope={scope}
          organization={organization}
          {...(editing === 'new'
            ? {}
            : {
                provider: edited ?? editing,
                unavailable: edited === undefined,
              })}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open && !command.pending) setRemoving(undefined);
        }}
        title="Remove identity provider?"
        description="This ends its sessions and removes its sign-in identities. Required domains must have another current, tested provider first."
        confirmLabel="Remove provider"
        pending={command.pending}
        locked={command.pending}
        confirmDisabled={!editable || command.expired}
        error={command.error}
        unconfirmed={
          command.uncertain
            ? { onRetry: command.retry, onDismiss: () => undefined }
            : undefined
        }
        onConfirm={() =>
          removing === undefined
            ? undefined
            : command.send({
                kind: 'removeProvider',
                providerId: removing.id,
                input: { expectedRevision: organization.revision },
              })
        }
      />
    </SettingsSection>
  );
}
