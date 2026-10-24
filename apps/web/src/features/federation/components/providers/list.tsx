import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useState } from 'react';
import { FEDERATION_LIMITS, type FederationSettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
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
      <RemoveProviderDialog
        removing={removing}
        organization={organization}
        command={command}
        editable={editable}
        onClose={() => {
          setRemoving(undefined);
        }}
      />
    </SettingsSection>
  );
}

function RemoveProviderDialog({
  removing,
  organization,
  command,
  editable,
  onClose,
}: Readonly<{
  removing: Organization['providers'][number] | undefined;
  organization: Organization;
  command: ReturnType<typeof useFederationCommand>;
  editable: boolean;
  onClose: () => void;
}>) {
  const changeConfirmationOpen = (open: boolean) => {
    if (!open && !command.pending) onClose();
  };
  const confirmationRetry = command.uncertain
    ? { onRetry: command.retry, onDismiss: () => undefined }
    : undefined;
  const confirmBlocked = command.pending || !editable || command.expired;
  return (
    <ConfirmDialog
      state={{
        open: removing !== undefined,
        onOpenChange: changeConfirmationOpen,
        locked: command.pending,
      }}
      title="Remove identity provider?"
      description="This ends its sessions and removes its sign-in identities. Required domains must have another current, tested provider first."
      onSubmit={
        confirmationRetry?.onRetry ??
        (() =>
          removing === undefined
            ? undefined
            : command.send({
                kind: 'removeProvider',
                providerId: removing.id,
                input: { expectedRevision: organization.revision },
              }))
      }
      submitDisabled={confirmBlocked}
      footer={
        <ConfirmationFooter>
          {confirmationRetry === undefined ? (
            <DialogClose
              disabled={command.pending}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                confirmationRetry.onDismiss();
                changeConfirmationOpen(false);
              }}
            >
              Close
            </Button>
          )}
          <ProgressButton
            type="submit"
            variant="primary"
            pending={command.pending}
            pendingLabel="Remove provider"
            disabled={!editable || command.expired}
          >
            {confirmationRetry === undefined ? 'Remove provider' : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={command.error}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
