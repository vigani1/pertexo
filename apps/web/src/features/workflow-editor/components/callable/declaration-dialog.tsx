import { useState, type ReactNode, type ComponentProps } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';
import { DeclarationForm } from './declaration-form';

export function DeclarationDialog({
  editable,
  children,
  finalFocus,
}: Readonly<{
  editable: boolean;
  children: ReactNode;
  finalFocus?: ComponentProps<typeof SheetContent>['finalFocus'];
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
    <Sheet
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
      <SheetContent
        variant="form"
        finalFocus={finalFocus}
        className="flex max-w-2xl flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 px-6 pt-6 pb-4">
          <SheetTitle>Workflow contract</SheetTitle>
          <SheetDescription>
            Define accepted input and the value returned by completed runs.
            Contracts apply after you publish.
          </SheetDescription>
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
          actions={{
            cancel: { kind: 'close', label: 'Keep editing', variant: 'ghost' },
            confirm: {
              label: 'Discard changes',
              type: 'submit',
              variant: 'destructive',
              pendingLabel: 'Discard changes',
            },
          }}
        ></ConfirmDialog>
      </SheetContent>
    </Sheet>
  );
}
