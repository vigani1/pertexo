import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import { useState, type ReactNode, type ComponentProps } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
} from '@/components/patterns/actions/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogClose,
} from '@/components/ui/dialog';
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';
import { DeclarationForm } from './declaration-form';

export function DeclarationDialog({
  editable,
  children,
  finalFocus,
}: Readonly<{
  editable: boolean;
  children: ReactNode;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}>) {
  const store = useEditorStoreApi();
  const inConflict = useEditorStore(
    (state) => state.save.status === 'conflict',
  );
  const [session, setSession] = useState<Readonly<{
    graph: WorkflowGraphContract;
    dirty: boolean;
    discard: boolean;
  }> | null>(null);
  function close() {
    setSession(null);
  }
  function requestClose() {
    if (session === null) return;
    if (session.dirty) setSession({ ...session, discard: true });
    else close();
  }
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (open)
          setSession({
            graph: store.getState().graph,
            dirty: false,
            discard: false,
          });
        else requestClose();
      }}
    >
      {children}
      <DialogContent
        placement="top"
        finalFocus={finalFocus}
        className="flex max-w-2xl flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle>Workflow contract</DialogTitle>
          <DialogDescription>
            Define accepted input and the value returned by completed runs.
            Contracts apply after you publish.
          </DialogDescription>
        </div>
        {session === null ? null : (
          <DeclarationForm
            graph={session.graph}
            editable={editable && !inConflict}
            onChange={() => {
              setSession((current) => current && { ...current, dirty: true });
            }}
            onClose={requestClose}
            onApply={(next) => {
              const current = store.getState();
              if (!editable || current.save.status === 'conflict') return;
              // Other graph edits remain owned by the editor; this form changes only its declaration.
              const { callable: _callable, ...ordinaryGraph } = current.graph;
              current.transact(
                next.callable === undefined
                  ? ordinaryGraph
                  : { ...current.graph, callable: next.callable },
              );
              close();
            }}
          />
        )}
        <ConfirmDialog
          state={{
            open: session?.discard ?? false,
            onOpenChange: (open) => {
              if (!open && session !== null)
                setSession({ ...session, discard: false });
            },
            locked: false,
          }}
          title="Discard contract changes?"
          description="These contract edits have not been applied to the workflow draft."
          onSubmit={close}
          footer={
            <ConfirmationFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>
                Keep editing
              </DialogClose>
              <ProgressButton
                type="submit"
                variant="destructive"
                pendingLabel="Discard changes"
              >
                Discard changes
              </ProgressButton>
            </ConfirmationFooter>
          }
        ></ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
