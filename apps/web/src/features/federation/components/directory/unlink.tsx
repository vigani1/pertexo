import { DialogFooter } from '@/components/ui/dialog';
import { useState } from 'react';
import type {
  DirectorySettings,
  FederationSettings,
  AccessibleWorkspace,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { useDirectoryCommand } from '../../data/directory.mutations';
import type { FederationScope } from '../../data/settings.api';
import { CommandFeedback } from '../command-feedback';

export function DirectoryWorkspaceLinks({
  scope,
  settings,
  organization,
  workspace,
}: Readonly<{
  scope: FederationScope;
  settings: DirectorySettings;
  organization: NonNullable<FederationSettings['organization']>;
  workspace: AccessibleWorkspace;
}>) {
  const [review, setReview] = useState<
    Readonly<{
      targetWorkspaceId: string;
      name: string;
      expectedRevision: number;
    }>
  >();
  const command = useDirectoryCommand(scope, () => {
    setReview(undefined);
  });
  return (
    <SettingsSection
      title="Workspace delegation"
      description="Either workspace owner can revoke a non-control link. Unlinking removes directory-managed grants in that workspace; manual memberships and accounts stay intact."
    >
      <ul className="divide-y divide-border">
        {organization.workspaces.map((linked) => {
          const canUnlinkWorkspace =
            workspace.status === 'active' &&
            linked.workspaceId !== settings.controlWorkspaceId &&
            (settings.canManage ||
              (linked.workspaceId === workspace.id &&
                workspace.role === 'owner'));
          return (
            <li
              key={linked.workspaceId}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <span className="min-w-0 break-words">
                {linked.name}
                {linked.workspaceId === settings.controlWorkspaceId
                  ? ' · Control workspace'
                  : ''}
              </span>
              {canUnlinkWorkspace ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={command.pending || command.uncertain}
                  onClick={() => {
                    setReview({
                      targetWorkspaceId: linked.workspaceId,
                      name: linked.name,
                      expectedRevision: settings.revision,
                    });
                  }}
                >
                  Unlink {linked.name}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {review === undefined ? null : (
        <Dialog
          open
          disablePointerDismissal={command.pending || command.uncertain}
          onOpenChange={(open) => {
            if (!open && !command.pending && !command.uncertain)
              setReview(undefined);
          }}
        >
          <DialogContent>
            <DialogTitle>Unlink {review.name}?</DialogTitle>
            <DialogDescription>
              Directory-managed members lose access to this workspace
              immediately and their existing sessions end. Manual members keep
              their access. Linking again requires both workspace owners.
            </DialogDescription>
            <div className="mt-5 space-y-4">
              <CommandFeedback command={command} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={command.pending || command.uncertain}
                  onClick={() => {
                    setReview(undefined);
                  }}
                >
                  Cancel
                </Button>
                <ProgressButton
                  type="button"
                  variant="destructive"
                  pending={command.pending}
                  pendingLabel="Unlinking…"
                  disabled={command.uncertain}
                  onClick={() =>
                    void command.send({
                      kind: 'unlink',
                      targetWorkspaceId: review.targetWorkspaceId,
                      input: { expectedRevision: review.expectedRevision },
                    })
                  }
                >
                  Unlink workspace
                </ProgressButton>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </SettingsSection>
  );
}
