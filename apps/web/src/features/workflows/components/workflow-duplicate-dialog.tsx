import { useCallback, useState, type ComponentProps } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  workflowDuplicateRequestSchema,
  type WorkflowDuplicateRequest,
  type WorkflowSummary,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../model/rename';
import { useWorkflowDuplicate } from '../hooks/use-workflow-duplicate';
import { canDuplicateWorkflow } from '../model/duplicate/allowed';

type WorkflowDuplicateDialogProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  source: WorkflowDuplicateRequest['source'];
  versionNumber?: number;
  allowed?: boolean;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}>;

export function WorkflowDuplicateDialog({
  apiClient,
  userId,
  workspace,
  workflow,
  source,
  versionNumber,
  allowed = true,
  onClose,
  onCreated,
  finalFocus,
}: WorkflowDuplicateDialogProps) {
  const [name, setName] = useState(
    () => `${workflow.name.slice(0, 121)} (copy)`,
  );
  const validation = useFieldValidation<'name'>();
  const clearSensitiveName = useCallback(() => {
    setName('');
  }, []);
  const command = useWorkflowDuplicate({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId: workflow.id,
    source,
    allowed: allowed && canDuplicateWorkflow(workspace, workflow),
    onCreated,
    onAccessLost: clearSensitiveName,
  });
  const { state } = command;
  const pending = state.kind === 'sending' || state.kind === 'loading';
  const locked = pending || state.kind === 'uncertain';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent finalFocus={finalFocus}>
        <DialogTitle>Duplicate workflow</DialogTitle>
        <DialogDescription>
          {state.kind === 'denied' ? (
            'Your access to this source changed.'
          ) : (
            <>
              Make an unpublished copy of “{workflow.name}”. It starts as a
              draft; nothing runs until you publish it.
            </>
          )}
        </DialogDescription>
        <form
          noValidate
          className="mt-5 flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (state.kind === 'uncertain') {
              command.retry();
              return;
            }
            if (!validation.submit({ name: workflowNameError(name) })) return;
            command.start(
              workflowDuplicateRequestSchema.parse({ name, source }).name,
            );
          }}
        >
          <DuplicateSourceReview
            source={source}
            versionNumber={versionNumber}
            state={state}
          />
          <FieldGroup>
            <LabelledField
              id="duplicate-workflow-name"
              label="Copy name"
              error={validation.error('name')}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={validation.register('name')}
                  autoFocus
                  autoComplete="off"
                  maxLength={128}
                  value={name}
                  disabled={locked || state.kind === 'denied'}
                  onChange={(event) => {
                    setName(event.target.value);
                    validation.change(
                      'name',
                      workflowNameError(event.target.value),
                    );
                  }}
                />
              )}
            </LabelledField>
          </FieldGroup>
          {state.error === undefined ? null : (
            <Notice
              tone={
                state.kind === 'uncertain' || state.kind === 'stale'
                  ? 'warning'
                  : 'destructive'
              }
            >
              {state.error}
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={onClose}
            >
              Cancel
            </Button>
            {state.kind === 'stale' || state.kind === 'failed' ? (
              <Button type="button" variant="outline" onClick={command.refresh}>
                Read current saved draft
              </Button>
            ) : null}
            <ProgressButton
              type="submit"
              variant="primary"
              pending={pending}
              pendingLabel={
                state.kind === 'loading' ? 'Reading source…' : 'Duplicating…'
              }
              disabled={state.kind !== 'ready' && state.kind !== 'uncertain'}
            >
              {state.kind === 'uncertain'
                ? 'Retry exact copy'
                : 'Duplicate workflow'}
            </ProgressButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateSourceReview({
  source,
  versionNumber,
  state,
}: Readonly<{
  source: WorkflowDuplicateRequest['source'];
  versionNumber: number | undefined;
  state: ReturnType<typeof useWorkflowDuplicate>['state'];
}>) {
  return (
    <p className="text-sm text-muted-foreground">
      {state.kind === 'denied' ? null : (
        <>
          {duplicateSourceLabel(source, versionNumber, state.draft)} Edits that
          aren’t saved yet stay out. The copy uses the same connections, and its
          run history starts empty.
        </>
      )}
    </p>
  );
}

function duplicateSourceLabel(
  source: WorkflowDuplicateRequest['source'],
  versionNumber: number | undefined,
  draft: Readonly<{ revision: number }> | undefined,
) {
  if (source.kind === 'version')
    return `Copies v${String(versionNumber ?? '?')} exactly as it was published.`;
  if (draft === undefined) return 'Reading the saved draft…';
  return `Copies the draft as last saved, revision ${String(draft.revision)}.`;
}
