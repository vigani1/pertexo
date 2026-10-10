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
}: WorkflowImportDialogProps) {
  const draft = useImportDraft(apiClient, userId, workspace);
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
          <DialogTitle>Import workflow</DialogTitle>
          <DialogDescription>
            {draft.denied
              ? 'Access changed. The file, preview and retained command have been cleared.'
              : `Create an independent, unpublished draft in “${workspace.name}”. Publishing and running are separate actions.`}
          </DialogDescription>
          {draft.denied ? null : (
            <div className="mt-5 flex flex-col gap-4">
              <Notice tone="warning">
                Workflow files are untrusted. Review all configuration and
                expressions before importing. Imported steps can cause real
                effects when you later publish, preview or run them. This check
                does not execute steps or promise that the workflow is safe.
              </Notice>
              <WorkflowImportSourceFields
                apiClient={apiClient}
                userId={userId}
                template={draft.template}
                setupValues={draft.setupValues}
                name={draft.name}
                fileGeneration={draft.fileGeneration}
                locked={draft.locked}
                validation={draft.validation}
                onChooseTemplate={draft.chooseTemplate}
                onChooseFile={(file) => void draft.chooseFile(file)}
                onNameChange={draft.changeName}
                onSetupChange={draft.changeSetup}
              />
              {draft.reading ? (
                <p role="status">Reading workflow file…</p>
              ) : null}
              <WorkflowImportReview
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                manifest={draft.manifest}
                preview={draft.preview}
                bindings={draft.bindings}
                disabled={draft.locked}
                onBindingsChange={draft.changeBindings}
              />
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
