import { isWorkspaceBrowsable } from '@/features/workspaces/public';
import {
  DialogFooter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ComponentProps } from 'react';
import type {
  WorkflowExportRequest,
  AccessibleWorkspace,
  WorkflowSummary,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { ApiClient } from '@/lib/api/client';
import {
  useWorkflowExportSession,
  type ReviewedSource,
} from '../../data/portability/workflow-export';
import { PortableGraphReview } from './portable-graph-review';
import { PortabilityAccessDeniedDialog } from './access-denied-dialog';

type WorkflowExportDialogProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  source: WorkflowExportRequest['source'];
  allowed?: boolean;
  onClose: () => void;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}>;

export function WorkflowExportDialog(props: WorkflowExportDialogProps) {
  if (
    props.allowed === false ||
    !isWorkspaceBrowsable(props.workspace) ||
    !props.workspace.capabilities.includes('workflow:read')
  )
    return (
      <PortabilityAccessDeniedDialog
        operation="export"
        onClose={props.onClose}
        finalFocus={props.finalFocus}
      />
    );
  const sourceKey =
    props.source.kind === 'draft' ? 'draft' : props.source.versionId;
  return (
    <WorkflowExportSession
      key={`${props.userId}:${props.workspace.id}:${props.workflow.id}:${sourceKey}`}
      {...props}
    />
  );
}

function WorkflowExportSession({
  apiClient,
  userId,
  workspace,
  workflow,
  source,
  onClose,
  finalFocus,
}: WorkflowExportDialogProps) {
  const model = useWorkflowExportSession({
    apiClient,
    userId,
    workspace,
    workflow,
    source,
  });
  const { review, acknowledgedDigest, pending, error, denied } = model.state;
  const { setAcknowledgedDigest, readAgain } = model.controls;
  function download() {
    void model.exportReviewed(onClose);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogTitle>Export workflow</DialogTitle>
        <DialogDescription>
          {denied
            ? 'Access changed. The reviewed source has been cleared.'
            : `Review the exact saved source of “${workflow.name}” before downloading it.`}
        </DialogDescription>
        {denied ? null : (
          <ExportSourceReview
            review={review}
            acknowledgedDigest={acknowledgedDigest}
            pending={pending}
            onAcknowledge={setAcknowledgedDigest}
          />
        )}
        {error === undefined ? null : (
          <Notice tone="destructive" className="mt-4">
            {error}
          </Notice>
        )}
        <DialogFooter className="mt-5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!denied && review === undefined && !pending ? (
            <Button variant="outline" onClick={readAgain}>
              Read saved source
            </Button>
          ) : null}
          <ProgressButton
            variant="primary"
            pending={pending}
            pendingLabel={
              review === undefined ? 'Reading source…' : 'Preparing download…'
            }
            disabled={
              denied ||
              review === undefined ||
              acknowledgedDigest !== review.digest
            }
            onClick={download}
          >
            Download workflow JSON
          </ProgressButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExportSourceReview({
  review,
  acknowledgedDigest,
  pending,
  onAcknowledge,
}: Readonly<{
  review: ReviewedSource | undefined;
  acknowledgedDigest: string | undefined;
  pending: boolean;
  onAcknowledge: (value: string | undefined) => void;
}>) {
  return (
    <div className="mt-5 flex flex-col gap-4">
      <Notice tone="warning">
        Credentials and workspace connection references are excluded.
        Configuration, literals, labels and expressions may still contain
        secrets or private information. Nothing is automatically scrubbed.
        Inspect every value before sharing the file.
      </Notice>
      {review === undefined ? null : (
        <>
          <p className="text-xs text-muted-foreground">
            {review.label}. Edits that aren’t saved yet stay out.
          </p>
          <PortableGraphReview
            graph={review.graph}
            label="Complete saved source graph"
          />
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={acknowledgedDigest === review.digest}
              disabled={pending}
              onCheckedChange={(checked) => {
                onAcknowledge(checked ? review.digest : undefined);
              }}
            />
            I reviewed this exact graph, including configuration and
            expressions, and understand that private values may remain in the
            download.
          </label>
        </>
      )}
    </div>
  );
}
