import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DirectoryAdoptionQuery,
  DirectoryAdoptionPreview,
} from '@pertexo/contracts';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { adoptionQueryOptions } from '../../data/directory.queries';
import { useDirectoryCommand } from '../../data/directory.mutations';
import type { FederationScope } from '../../data/settings.api';
import { CommandFeedback } from '../command-feedback';

export function DirectoryAdoptionDialog({
  scope,
  input,
  onClose,
}: Readonly<{
  scope: FederationScope;
  input: DirectoryAdoptionQuery;
  onClose: () => void;
}>) {
  const command = useDirectoryCommand(scope, onClose);
  const preview = useQuery({
    ...adoptionQueryOptions(scope, input),
    refetchOnWindowFocus: false,
  });
  return (
    <Dialog
      open
      disablePointerDismissal={command.pending || command.uncertain}
      onOpenChange={(open) => {
        if (!open && !command.pending && !command.uncertain) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Review directory management</DialogTitle>
        <DialogDescription>
          Adopting an existing manual membership delegates its role and removal
          to the organization directory. The recovery owner stays manual.
        </DialogDescription>
        <div className="mt-5 space-y-4">
          {preview.isPending ? (
            <p role="status">Loading membership review…</p>
          ) : preview.isError ? (
            <Notice
              tone="warning"
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void preview.refetch()}
                >
                  Retry review
                </Button>
              }
            >
              This membership could not be reviewed.
            </Notice>
          ) : preview.data.eligible ? (
            <AdoptionReview
              command={command}
              preview={preview.data}
              onClose={onClose}
            />
          ) : (
            <>
              <Notice>{preview.data.reason}</Notice>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
function AdoptionReview({
  command,
  preview,
  onClose,
}: Readonly<{
  command: ReturnType<typeof useDirectoryCommand>;
  preview: Extract<DirectoryAdoptionPreview, { eligible: true }>;
  onClose: () => void;
}>) {
  // A confirmation keeps the exact reviewed revisions across background refreshes.
  const [reviewed] = useState(preview);
  return (
    <>
      <p className="text-sm">
        <strong>{reviewed.displayName}</strong> currently has the{' '}
        {reviewed.currentRole} role. Directory management will use{' '}
        <strong>{reviewed.command.role}</strong>, and future group changes or
        deprovisioning will control this membership.
      </p>
      <CommandFeedback command={command} />
      <div className="flex flex-wrap gap-2">
        <ProgressButton
          type="button"
          variant="primary"
          pending={command.pending}
          pendingLabel="Adopting membership…"
          disabled={command.uncertain}
          onClick={() =>
            void command.send({ kind: 'adopt', input: reviewed.command })
          }
        >
          Adopt this membership
        </ProgressButton>
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending || command.uncertain}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </>
  );
}
