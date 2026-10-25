import { DialogFooter } from '@/components/ui/dialog';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { useWorkflowImportCommand } from '../../data/portability/mutations';

export function WorkflowImportActions({
  commandState,
  onClose,
  onStartAnotherImport,
  onOpenWorkflow,
  onSubmitImport,
  children,
  access,
}: Readonly<{
  commandState: ReturnType<typeof useWorkflowImportCommand>['state'];
  onClose: () => void;
  onStartAnotherImport: () => void;
  onOpenWorkflow: (workflowId: string) => void;
  onSubmitImport: () => void;
  children: ReactNode;
  access: Readonly<{
    accessDenied: boolean;
    checkingAccess: boolean;
    canImport: boolean;
  }>;
}>) {
  const { accessDenied, checkingAccess, canImport } = access;

  return (
    <DialogFooter className="mt-5">
      <Button variant="ghost" onClick={onClose}>
        {commandState.kind === 'uncertain' || commandState.kind === 'confirmed'
          ? 'Close'
          : 'Cancel'}
      </Button>
      {children}
      {commandState.kind === 'confirmed' &&
      commandState.workflowId !== undefined &&
      !accessDenied ? (
        <>
          <ProgressButton
            variant="outline"
            pending={checkingAccess}
            pendingLabel="Checking access…"
            onClick={onStartAnotherImport}
          >
            Start another import
          </ProgressButton>
          <Button
            variant="primary"
            onClick={() => {
              if (commandState.workflowId !== undefined)
                onOpenWorkflow(commandState.workflowId);
            }}
          >
            Open imported workflow
          </Button>
        </>
      ) : (
        <ProgressButton
          variant="primary"
          pending={commandState.kind === 'sending'}
          pendingLabel="Importing…"
          disabled={
            accessDenied || (commandState.kind !== 'uncertain' && !canImport)
          }
          onClick={onSubmitImport}
        >
          {commandState.kind === 'uncertain'
            ? 'Retry exact import'
            : 'Import unpublished draft'}
        </ProgressButton>
      )}
    </DialogFooter>
  );
}

/** One visible feedback owner for a command result or its source-read failure. */
export function WorkflowImportFeedback({
  state,
  error,
  denied,
}: Readonly<{
  state: ReturnType<typeof useWorkflowImportCommand>['state'];
  error: string | undefined;
  denied: boolean;
}>) {
  const failure = state.error ?? error;
  return (
    <>
      {failure === undefined ? null : (
        <Notice
          tone={state.kind === 'uncertain' ? 'warning' : 'destructive'}
          className="mt-4"
        >
          {failure}
        </Notice>
      )}
      {state.kind === 'confirmed' && !denied ? (
        <Notice tone="success" className="mt-4">
          Draft created. Nothing runs until you publish it.
        </Notice>
      ) : null}
    </>
  );
}
