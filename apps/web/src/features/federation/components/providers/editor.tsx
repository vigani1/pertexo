import { DialogFooter } from '@/components/ui/dialog';
import type { ReactNode } from 'react';
import type { FederationSettings } from '@pertexo/contracts';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { FederationScope } from '../../data/settings.api';
import type { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';

export type ProviderEditorProps = Readonly<{
  scope: FederationScope;
  organization: NonNullable<FederationSettings['organization']>;
  unavailable?: boolean;
  onClose: () => void;
}>;
export function ProviderDialog({
  title,
  description,
  locked,
  unavailable,
  onClose,
  children,
}: Readonly<{
  title: string;
  description: string;
  locked: boolean;
  unavailable: boolean;
  onClose: () => void;
  children: ReactNode;
}>) {
  return (
    <Dialog
      open
      disablePointerDismissal={locked}
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {unavailable ? (
          <Notice tone="warning">
            This provider was removed in another tab. Your inputs are kept, but
            it cannot be saved. Close the form to discard these edits.
          </Notice>
        ) : null}
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ProviderFooter({
  command,
  disabled,
  onClose,
}: Readonly<{
  command: ReturnType<typeof useFederationCommand>;
  disabled: boolean;
  onClose: () => void;
}>) {
  const locked = command.pending || command.uncertain;
  return (
    <>
      <CommandFeedback command={command} />
      <p className="text-xs text-muted-foreground">
        Changing a required provider needs another tested provider first, or
        required SSO turned off. Provider changes end its existing sessions.
      </p>
      <DialogFooter className="pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={locked}
        >
          Cancel
        </Button>
        <ProgressButton
          type="submit"
          pending={command.pending}
          pendingLabel="Saving…"
          disabled={locked || disabled}
        >
          Save provider
        </ProgressButton>
      </DialogFooter>
    </>
  );
}
