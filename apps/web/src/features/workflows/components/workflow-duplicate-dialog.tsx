import { useCallback, useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  workflowDuplicateRequestSchema,
  type WorkflowDuplicateRequest,
  type WorkflowSummary,
} from '@pertexo/contracts';
import { useNavigate } from '@tanstack/react-router';
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
import { canDuplicateWorkflow } from '../model/duplicate/can-duplicate';

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
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  source: WorkflowDuplicateRequest['source'];
  versionNumber?: number;
  allowed?: boolean;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
}>) {
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
      <DialogContent>
        <DialogTitle>Duplicate workflow</DialogTitle>
        <DialogDescription>
          {state.kind === 'denied' ? (
            'Your access to this source changed.'
          ) : (
            <>
              Make an independent, unpublished copy of “{workflow.name}” in this
              workspace. Publishing and running remain separate actions.
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
          <p className="text-sm text-muted-foreground">
            {state.kind === 'denied' ? null : (
              <>
                {source.kind === 'version'
                  ? `Source: immutable version v${String(versionNumber ?? '?')}.`
                  : state.draft === undefined
                    ? 'Reading the saved current draft…'
                    : `Source: saved draft revision ${String(state.draft.revision)}.`}{' '}
                Unsaved browser edits are never copied. Connection references
                stay in this workspace; credentials and operational history are
                not copied.
              </>
            )}
          </p>
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

/** Shared detail action; Build supplies its own dirty/save guard. */
export function WorkflowDuplicateAction({
  apiClient,
  userId,
  workspace,
  workflow,
  blocked = false,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  blocked?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!canDuplicateWorkflow(workspace, workflow)) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={blocked}
        title={
          blocked
            ? 'Save or resolve unfinished edits and conflicts before copying the saved draft.'
            : undefined
        }
        onClick={() => {
          setOpen(true);
        }}
      >
        Duplicate…
      </Button>
      {open ? (
        <WorkflowDuplicateDialog
          key={`${userId}:${workspace.id}:${workflow.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={workflow}
          source={{ kind: 'draft' }}
          allowed={!blocked}
          onClose={() => {
            setOpen(false);
          }}
          onCreated={(workflowId) => {
            setOpen(false);
            void navigate({
              to: '/w/$workspaceId/workflows/$workflowId',
              params: { workspaceId: workspace.id, workflowId },
            });
          }}
        />
      ) : null}
    </>
  );
}
