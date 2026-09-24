import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceCreation } from '../../mutations/use-workspace-creation';
import { WorkspaceCreationForm } from './workspace-creation-form';

/** "+ New workspace" from the picker: the same form, in a side lens. */
export function WorkspaceCreationSheet({
  apiClient,
  userId,
  open,
  onOpenChange,
  onCreated,
  onSessionInvalidated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
}>) {
  const [formKey, setFormKey] = useState(0);
  const command = useWorkspaceCreation({
    apiClient,
    userId,
    onCreated,
    onSessionInvalidated: () => {
      onOpenChange(false);
      onSessionInvalidated();
    },
  });

  function close() {
    command.clearError();
    setFormKey((key) => key + 1);
    onOpenChange(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // An in-flight or uncertain request stays on screen until resolved.
        if (!next && !command.locked && !command.created) close();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New workspace</SheetTitle>
          <SheetDescription>
            A home for your team’s workflows, connections and runs. You’ll be
            its owner.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <WorkspaceCreationForm
            key={formKey}
            idPrefix="workspace-sheet"
            command={command}
            onCancel={close}
            onStartOver={() => {
              setFormKey((key) => key + 1);
            }}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
