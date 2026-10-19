import { useState } from 'react';
import { FEDERATION_LIMITS, type FederationSettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
import { ProviderSelectionDialog, type ProviderSelection } from './selection';
import { ProviderEntry } from './entry';
import { SamlMetadata } from './metadata';
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
  const [editing, setEditing] = useState<ProviderSelection>();
  const [removing, setRemoving] = useState<Organization['providers'][number]>();
  const command = useFederationCommand(scope, () => {
    setRemoving(undefined);
  });
  const locked = !editable || command.pending || command.uncertain;
  const callback = new URL(
    '/v1/auth/federation/oidc/callback',
    window.location.origin,
  ).toString();
  return (
    <SettingsSection
      title="Identity providers"
      description="Configure OIDC or SAML identity providers. Password/social sign-in stays available until a verified domain requires SSO."
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          OIDC providers use this exact redirect URI:
        </p>
        <div className="flex min-w-0 items-start gap-2">
          <code className="min-w-0 break-all text-xs">{callback}</code>
          <CopyButton value={callback} label="Copy OIDC redirect URI" />
        </div>
      </div>
      <SamlMetadata scope={scope} organizationId={organization.id} />
      {organization.providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No organization providers configured.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {organization.providers.map((provider) => (
            <ProviderEntry
              key={provider.id}
              scope={scope}
              organization={organization}
              provider={provider}
              locked={locked}
              editable={editable}
              onEdit={setEditing}
              onRemove={setRemoving}
              navigateToProvider={navigateToProvider}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={
            locked ||
            organization.providers.length >= FEDERATION_LIMITS.providers
          }
          onClick={() => {
            setEditing('new-oidc');
          }}
        >
          Add OIDC provider
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            locked ||
            organization.providers.length >= FEDERATION_LIMITS.providers ||
            window.location.protocol !== 'https:'
          }
          onClick={() => {
            setEditing('new-saml');
          }}
        >
          Add SAML provider
        </Button>
      </div>
      {removing === undefined ? <CommandFeedback command={command} /> : null}
      <ProviderSelectionDialog
        selected={editing}
        scope={scope}
        organization={organization}
        onClose={() => {
          setEditing(undefined);
        }}
      />
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
