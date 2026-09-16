import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { NodePreviewDialog } from './components/node-preview-dialog';
import { PublishWorkflowDialog } from './components/publish-workflow-dialog';
import { StartWorkflowRunDialog } from './components/start-workflow-run-dialog';
import { WorkflowValidationFindings } from './components/workflow-validation-findings';
import type { WorkflowValidationTarget } from './model/validation-target';
import type {
  SavedDraftIdentity,
  WorkflowCommandSession,
} from './use-workflow-command-session';

export function WorkflowActions({
  apiClient,
  workspace,
  userId,
  workflowId,
  selectedNodeId,
  graph,
  generation,
  revision,
  commandSession,
  ensureSaved,
  onValidationTarget,
}: Readonly<{
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  userId: string;
  workflowId: string;
  selectedNodeId: string | null;
  graph: WorkflowGraphContract;
  generation: number;
  revision: number;
  commandSession: WorkflowCommandSession;
  ensureSaved: () => Promise<SavedDraftIdentity>;
  onValidationTarget: (target: WorkflowValidationTarget) => void;
}>) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { publication, runSubmission } = commandSession;
  const {
    validation,
    validationPending,
    validationError,
    publicationReceipt,
    publishPending,
    publishError,
    publishRecoveryPending,
    clearPublishError,
    validate: requestValidation,
    publish: requestPublish,
  } = publication;
  const validationStale =
    validation !== undefined &&
    (validation.generation !== generation || validation.revision !== revision);
  const hasUnpublishedEdits =
    publicationReceipt !== undefined &&
    (publicationReceipt.generation !== generation ||
      publicationReceipt.revision !== revision);
  const validationFindingCount =
    (validation?.report.issues.length ?? 0) +
    (validation?.report.compatibility.issues.length ?? 0);
  const canPublish = workspace.capabilities.includes('workflow:publish');
  const canStartRun = workspace.capabilities.includes('run:start');
  const canPreview = workspace.capabilities.includes('workflow:update');

  async function publishAndClose() {
    if (await requestPublish()) setPublishOpen(false);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={validationPending}
          onClick={() => void requestValidation()}
        >
          {validationPending ? 'Validating…' : 'Validate'}
        </Button>
        {canPreview ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selectedNodeId === null}
            onClick={() => {
              setPreviewOpen(true);
            }}
          >
            Preview node
          </Button>
        ) : null}
        {canPublish ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              clearPublishError();
              setPublishOpen(true);
            }}
          >
            Publish
          </Button>
        ) : null}
        {canStartRun && runSubmission.acceptedRunId !== undefined ? (
          <Button
            type="button"
            size="sm"
            disabled={runSubmission.pending}
            onClick={() => void runSubmission.openAcceptedRun()}
          >
            {runSubmission.pending ? 'Verifying…' : 'Open accepted run'}
          </Button>
        ) : canStartRun ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRunOpen(true);
            }}
          >
            Start run
          </Button>
        ) : null}
      </div>
      <div className="basis-full text-right text-xs" aria-live="polite">
        {validationError ? (
          <span className="text-destructive">{validationError}</span>
        ) : validation ? (
          <span
            className={
              validationStale ? 'text-secondary' : 'text-muted-foreground'
            }
          >
            Validation:{' '}
            {validation.report.valid
              ? 'valid'
              : `${String(validationFindingCount)} ${validationFindingCount === 1 ? 'finding' : 'findings'}`}
            {validationStale ? ' · stale after edits' : ''}
          </span>
        ) : null}
        {publicationReceipt ? (
          <span className="font-mono text-muted-foreground">
            Published {publicationReceipt.versionId}
            {hasUnpublishedEdits ? ' · subsequent edits unpublished' : ''}
          </span>
        ) : null}
        {runSubmission.acceptedRunId === undefined ? null : (
          <span className="text-muted-foreground">
            A run was accepted while this editor was paused. Open it explicitly;
            it will not be submitted again.
          </span>
        )}
      </div>
      {validation === undefined || validationFindingCount === 0 ? null : (
        <div className="basis-full">
          <WorkflowValidationFindings
            structuralIssues={validation.report.issues}
            compatibilityIssues={validation.report.compatibility.issues}
            graph={graph}
            stale={validationStale}
            onNavigate={onValidationTarget}
          />
        </div>
      )}
      <PublishWorkflowDialog
        open={publishOpen}
        pending={publishPending}
        error={publishError}
        recoveryPending={publishRecoveryPending}
        onOpenChange={setPublishOpen}
        onPublish={() => void publishAndClose()}
      />
      <StartWorkflowRunDialog
        open={runOpen}
        pending={runSubmission.pending}
        error={runSubmission.error}
        retryAvailable={runSubmission.retryAvailable}
        onOpenChange={setRunOpen}
        onRetry={runSubmission.retry}
        onStartNew={runSubmission.startNew}
      />
      {selectedNodeId === null ? null : (
        <NodePreviewDialog
          key={`${userId}:${workspace.id}:${workflowId}:${selectedNodeId}:${String(generation)}`}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          apiClient={apiClient}
          workspaceId={workspace.id}
          workflowId={workflowId}
          nodeId={selectedNodeId}
          ensureSaved={ensureSaved}
        />
      )}
    </>
  );
}
