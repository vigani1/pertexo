import type { AccessibleWorkspace } from '@pertexo/contracts';
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
import { useWorkspaceCreation } from '../../data/mutations/use-workspace-creation';
import { WorkspaceCreationForm } from './workspace-creation-form';
/** "+ New workspace" from the picker: the same form, in a side lens. */
export function WorkspaceCreationSheet({
  apiClient,
  userId,
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspace: AccessibleWorkspace) => void;
}>) {
  const [formKey, setFormKey] = useState(0);
  const command = useWorkspaceCreation({
    apiClient,
    userId,
    onCreated,
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
        // An in-flight request stays on screen until it settles.
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
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
