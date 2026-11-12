import { DialogFooter } from '@/components/ui/dialog';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ExpiredAttemptNotice } from '@/components/patterns/states/expired-attempt-notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { useWorkflowImportCommand } from '../../data/portability/mutations';
export function WorkflowImportActions({
  commandState,
  onClose,
  onStartAnotherImport,
  onOpenWorkflow,
  onSubmitImport,
  onRetryImport,
  children,
  access,
}: Readonly<{
  commandState: ReturnType<typeof useWorkflowImportCommand>['state'];
  onClose: () => void;
  onStartAnotherImport: () => void;
  onOpenWorkflow: (workflowId: string) => void;
  onSubmitImport: () => void;
  onRetryImport: () => void;
  children: ReactNode;
  access: Readonly<{
    accessDenied: boolean;
    canImport: boolean;
  }>;
}>) {
  const { accessDenied, canImport } = access;
  const createdId =
    commandState.kind === 'confirmed' ? commandState.workflowId : undefined;
  const uncertain = commandState.kind === 'uncertain';
  return (
    <DialogFooter className="mt-5">
      <Button variant="ghost" onClick={onClose}>
        {uncertain || commandState.kind === 'confirmed' ? 'Close' : 'Cancel'}
      </Button>
      {children}
      {createdId !== undefined && !accessDenied ? (
        <>
          <Button variant="outline" onClick={onStartAnotherImport}>
            Start another import
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onOpenWorkflow(createdId);
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
          disabled={accessDenied || (!uncertain && !canImport)}
          onClick={uncertain ? onRetryImport : onSubmitImport}
        >
          {uncertain ? 'Retry exact import' : 'Import unpublished draft'}
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
  onStartNewAttempt,
}: Readonly<{
  state: ReturnType<typeof useWorkflowImportCommand>['state'];
  error: string | undefined;
  denied: boolean;
  onStartNewAttempt: () => void;
}>) {
  let failure = error;
  if (state.kind === 'editable' && state.failure !== undefined)
    failure = state.failure.message;
  if (state.kind === 'uncertain')
    failure =
      'We couldn’t confirm whether the workflow was imported. Retrying is safe — it won’t make a duplicate.';
  return (
    <>
      {state.kind === 'expired' ? (
        <ExpiredAttemptNotice onNewAttempt={onStartNewAttempt} />
      ) : null}
      {failure === undefined ? null : (
        <Notice tone="destructive" className="mt-4">
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
