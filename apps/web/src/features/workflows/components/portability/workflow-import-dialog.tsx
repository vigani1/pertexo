import { useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { ApiClient } from '@/lib/api/client';
import { WorkflowImportLeaveGuard } from './workflow-import-leave-guard';
import { WorkflowImportReview } from './workflow-import-review';
import {
  WorkflowImportActions,
  WorkflowImportFeedback,
} from './import-actions';
import { WorkflowImportSourceFields } from './source-fields';
import { useImportDraft } from './use-import-draft';
import { PortabilityAccessDeniedDialog } from './access-denied-dialog';

type WorkflowImportDialogProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
  open?: boolean;
  onReopen?: () => void;
  /**
   * The ready-made example to start from. Without one the dialog imports a
   * file; with one it sets up that example, and the others stay a click away.
   */
  example?: string | undefined;
  initialName?: string | undefined;
}>;

export function WorkflowImportDialog(props: WorkflowImportDialogProps) {
  if (
    props.workspace.status !== 'active' ||
    !props.workspace.capabilities.includes('workflow:create')
  )
    return (
      <PortabilityAccessDeniedDialog
        operation="import"
        open={props.open ?? true}
        onClose={props.onClose}
      />
    );
  return (
    <WorkflowImportSession
      key={`${props.userId}:${props.workspace.id}`}
      {...props}
    />
  );
}

function WorkflowImportSession({
  apiClient,
  userId,
  workspace,
  onClose,
  onCreated,
  open = true,
  onReopen,
  example,
  initialName = '',
}: WorkflowImportDialogProps) {
  const draft = useImportDraft(apiClient, userId, workspace, initialName);
  // The example the dialog opened on is chosen once; after that, by hand.
  const [opening, setOpening] = useState(example);
  return (
    <>
      <WorkflowImportLeaveGuard
        workspaceId={workspace.id}
        unresolved={draft.unresolved}
        onReopen={() => onReopen?.()}
      />
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>
            {example === undefined
              ? 'Import workflow'
              : 'Start from an example'}
          </DialogTitle>
          <DialogDescription>
            {importDescription({
              denied: draft.denied,
              fromExample: example !== undefined,
              workspaceName: workspace.name,
            })}
          </DialogDescription>
          {draft.denied ? null : (
            <div className="mt-5 flex flex-col gap-5">
              <WorkflowImportSourceFields
                apiClient={apiClient}
                userId={userId}
                template={draft.template}
                manifest={draft.manifest}
                optionalSlots={draft.optionalSlots}
                setupValues={draft.setupValues}
                name={draft.name}
                fileGeneration={draft.fileGeneration}
                reading={draft.reading}
                locked={draft.locked}
                example={example}
                opening={opening}
                validation={draft.validation}
                onChooseTemplate={(template) => {
                  setOpening(undefined);
                  draft.chooseTemplate(template);
                }}
                onChooseFile={(file) => void draft.chooseFile(file)}
                onNameChange={draft.changeName}
                onSetupChange={draft.changeSetup}
              />
              <WorkflowImportReview
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                manifest={draft.manifest}
                preview={draft.preview}
                bindings={draft.bindings}
                optionalSlots={draft.optionalSlots}
                disabled={draft.locked}
                onBindingsChange={draft.changeBindings}
              />
              {draft.manifest === undefined ? null : (
                <Notice tone="warning">
                  Imported steps can call services and send messages once you
                  publish and run them. Check each step’s setup in Build before
                  publishing; this check doesn’t run anything.
                </Notice>
              )}
            </div>
          )}
          <WorkflowImportFeedback
            state={draft.commandState}
            error={draft.error}
            denied={draft.denied}
          />
          <WorkflowImportActions
            commandState={draft.commandState}
            accessDenied={draft.denied}
            checkingAccess={draft.resetting}
            canImport={draft.canImport}
            onClose={onClose}
            onStartAnotherImport={() => void draft.startAnother()}
            onOpenWorkflow={onCreated}
            onSubmitImport={draft.submitImport}
          >
            {!draft.locked ? (
              <ProgressButton
                variant="outline"
                pending={draft.previewing}
                pendingLabel="Checking…"
                disabled={!draft.complete || draft.reading}
                onClick={() => void draft.checkPreview()}
              >
                Preview import
              </ProgressButton>
            ) : null}
          </WorkflowImportActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

function importDescription(
  input: Readonly<{
    denied: boolean;
    fromExample: boolean;
    workspaceName: string;
  }>,
) {
  if (input.denied)
    return 'Access changed. The file, preview and retained command have been cleared.';
  if (input.fromExample)
    return `Set up a ready-made workflow in “${input.workspaceName}” as an unpublished draft. Nothing runs until you publish it.`;
  return `Bring a workflow into “${input.workspaceName}” as an unpublished draft. Nothing runs until you publish it.`;
}
