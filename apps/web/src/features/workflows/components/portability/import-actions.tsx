import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { useWorkflowImportCommand } from '../../data/portability/mutations';

export function WorkflowImportActions({
  commandState,
  accessDenied,
  checkingAccess,
  canImport,
  onClose,
  onStartAnotherImport,
  onOpenWorkflow,
  onSubmitImport,
  children,
}: Readonly<{
  commandState: ReturnType<typeof useWorkflowImportCommand>['state'];
  accessDenied: boolean;
  checkingAccess: boolean;
  canImport: boolean;
  onClose: () => void;
  onStartAnotherImport: () => void;
  onOpenWorkflow: (workflowId: string) => void;
  onSubmitImport: () => void;
  children: ReactNode;
}>) {
  return (
    <div className="mt-5 flex flex-wrap justify-end gap-2">
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
    </div>
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
          The independent workflow draft was created.
        </Notice>
      ) : null}
    </>
  );
}
