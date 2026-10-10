import { useState } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';
import { DeclarationForm } from './declaration-form';

export function DeclarationDialog({
  editable,
}: Readonly<{ editable: boolean }>) {
  const store = useEditorStoreApi();
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const [session, setSession] = useState<Readonly<{
    graph: WorkflowGraphContract;
    discard: boolean;
  }> | null>(null);
  function close() {
    store.getState().setInspectorScratch(false);
    setSession(null);
  }
  function requestClose() {
    if (session === null) return;
    if (store.getState().inspectorScratch)
      setSession({ ...session, discard: true });
    else close();
  }
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (open) setSession({ graph: store.getState().graph, discard: false });
        else requestClose();
      }}
    >
      <DialogTrigger
        disabled={session === null && scratch}
        aria-label="Workflow contract"
        className="inline-link rounded-sm font-sans text-[0.72rem] font-medium focus-ring"
      >
        Contract
      </DialogTrigger>
      <DialogContent
        placement="top"
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
              store.getState().setInspectorScratch(true);
            }}
            onClose={requestClose}
            onApply={(next) => {
              const current = store.getState();
              if (!editable || current.saveStatus === 'conflict') return;
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
          open={session?.discard === true}
          onOpenChange={(open) => {
            if (!open && session !== null)
              setSession({ ...session, discard: false });
          }}
          title="Discard contract changes?"
          description="These contract edits have not been applied to the workflow draft."
          tone="destructive"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={close}
        />
      </DialogContent>
    </Dialog>
  );
}
