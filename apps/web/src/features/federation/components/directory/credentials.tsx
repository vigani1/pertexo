import { DialogFooter } from '@/components/ui/dialog';
import { useState } from 'react';
import { DIRECTORY_LIMITS, type DirectorySettings } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ProgressButton } from '@/components/ui/progress-button';
import { formatDate } from '@/lib/format/time';
import { useDirectoryCommand } from '../../data/directory.mutations';
import type { FederationScope } from '../../data/settings.api';
import { CommandFeedback } from '../command-feedback';
import { DirectoryCredentialDialog } from './credential-dialog';

export function DirectoryCredentials({
  scope,
  settings,
  editable,
  onRefresh,
}: Readonly<{
  scope: FederationScope;
  settings: DirectorySettings;
  editable: boolean;
  onRefresh: () => void;
}>) {
  const [creating, setCreating] = useState(false),
    [revoke, setRevoke] = useState<DirectorySettings['credentials'][number]>();
  const command = useDirectoryCommand(scope, () => {
    setRevoke(undefined);
  });
  const endpoint = `${window.location.origin}/v1/auth/federation/scim/${settings.organizationId}/v2`;
  const active = settings.credentials.filter(
    (credential) => credential.revokedAt === null,
  ).length;
  return (
    <SettingsSection
      title="Provisioning credentials"
      description="Connect your identity provider to SCIM 2.0. Provisioning changes access across this organization’s linked workspaces; it never supplies passwords."
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3">
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">SCIM base URL</span>
          <p className="mt-1 font-mono text-xs break-all">{endpoint}</p>
        </div>
        <CopyButton value={endpoint} label="Copy SCIM base URL" />
      </div>
      <ul className="divide-y divide-border">
        {settings.credentials.map((credential) => (
          <li
            key={credential.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">{credential.name}</p>
              <p className="text-xs text-muted-foreground">
                {credential.revokedAt === null ? 'Active' : 'Revoked'} · Created{' '}
                {formatDate(credential.createdAt)}
              </p>
            </div>
            {editable && credential.revokedAt === null ? (
              <Button
                type="button"
                variant="outline"
                disabled={command.pending || command.uncertain}
                onClick={() => {
                  setRevoke(credential);
                }}
              >
                Revoke {credential.name}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {active} of {DIRECTORY_LIMITS.credentials} active credentials. Revoke an
        unused credential before creating another at the limit.
      </p>
      {settings.credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provisioning credentials yet.
        </p>
      ) : null}
      {editable ? (
        <Button
          type="button"
          variant="outline"
          disabled={active >= DIRECTORY_LIMITS.credentials}
          onClick={() => {
            setCreating(true);
          }}
        >
          Create provisioning credential
        </Button>
      ) : null}
      {creating ? (
        <DirectoryCredentialDialog
          scope={scope}
          revision={settings.revision}
          onRefresh={onRefresh}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      {revoke === undefined ? null : (
        <Dialog
          open
          disablePointerDismissal={command.pending || command.uncertain}
          onOpenChange={(open) => {
            if (!open && !command.pending && !command.uncertain)
              setRevoke(undefined);
          }}
        >
          <DialogContent>
            <DialogTitle>Revoke {revoke.name}?</DialogTitle>
            <DialogDescription>
              The identity provider will immediately lose provisioning access
              through this credential. Existing managed memberships remain;
              create and configure its replacement before revoking a working
              credential.
            </DialogDescription>
            <div className="mt-5 space-y-4">
              <CommandFeedback command={command} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={command.pending || command.uncertain}
                  onClick={() => {
                    setRevoke(undefined);
                  }}
                >
                  Cancel
                </Button>
                <ProgressButton
                  type="button"
                  variant="destructive"
                  pending={command.pending}
                  pendingLabel="Revoking…"
                  disabled={command.uncertain}
                  onClick={() =>
                    void command.send({
                      kind: 'revoke',
                      credentialId: revoke.id,
                      input: { expectedRevision: settings.revision },
                    })
                  }
                >
                  Revoke credential
                </ProgressButton>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </SettingsSection>
  );
}
