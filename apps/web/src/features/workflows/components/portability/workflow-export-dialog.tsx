import { DialogFooter } from '@/components/ui/dialog';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { WorkflowExportRequest } from '@pertexo/contracts';
import { portableGraphDigest } from '@pertexo/workflow-model';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  exportWorkflow,
  readWorkflowExportSource,
} from '../../data/portability/api';
import { downloadPortableWorkflow } from '../../model/portability';
import { usePortabilityLifetime } from './use-lifetime';
import { PortableGraphReview } from './portable-graph-review';
import { PortabilityAccessDeniedDialog } from './access-denied-dialog';

type ReviewedSource = Awaited<ReturnType<typeof readWorkflowExportSource>> & {
  digest: string;
};

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
    props.workspace.status !== 'active' ||
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
  const model = useExportSource({
    apiClient,
    userId,
    workspace,
    workflow,
    source,
  });
  const { review, acknowledgedDigest, pending, error, denied } = model.state;
  const { activeRequestRef, begin, verify, accessFailure } = model.requests;
  const {
    setPending,
    setError,
    setAcknowledgedDigest,
    setReview,
    setReadAttempt,
  } = model.controls;
  async function download() {
    const exportConfirmationBlocked =
      review === undefined ||
      acknowledgedDigest !== review.digest ||
      activeRequestRef.current !== undefined ||
      denied;
    if (exportConfirmationBlocked) return;
    const request = begin();
    activeRequestRef.current = request;
    setPending(true);
    setError(undefined);
    try {
      await verify({ signal: request.signal, creating: false });
      if (!request.current()) return;
      const manifest = await exportWorkflow({
        apiClient,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        body: { source, reviewedGraphDigest: review.digest },
        etag: 'etag' in review ? review.etag : undefined,
        signal: request.signal,
      });
      if (!request.current()) return;
      await verify({ signal: request.signal, creating: false });
      if (!request.current()) return;
      downloadPortableWorkflow(manifest);
      onClose();
    } catch (failure) {
      if (request.current() && !accessFailure(failure)) {
        setAcknowledgedDigest(undefined);
        setReview(undefined);
        setError(
          'The export was not downloaded. Read and review the saved source again before trying another export.',
        );
      }
    } finally {
      request.done();
      if (activeRequestRef.current === request) {
        activeRequestRef.current = undefined;
        if (request.current()) setPending(false);
      }
    }
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
            <Button
              variant="outline"
              onClick={() => {
                setPending(true);
                setReadAttempt((attempt) => attempt + 1);
              }}
            >
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
            onClick={() => void download()}
          >
            Download workflow JSON
          </ProgressButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useExportSource({
  apiClient,
  userId,
  workspace,
  workflow,
  source,
}: Pick<
  WorkflowExportDialogProps,
  'apiClient' | 'userId' | 'workspace' | 'workflow' | 'source'
>) {
  const [review, setReview] = useState<ReviewedSource>();
  const [acknowledgedDigest, setAcknowledgedDigest] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [readAttempt, setReadAttempt] = useState(0);
  const activeRequestRef = useRef<
    ReturnType<ReturnType<typeof usePortabilityLifetime>['begin']> | undefined
  >(undefined);
  const clear = useCallback(() => {
    setReview(undefined);
    setAcknowledgedDigest(undefined);
    setError(undefined);
    setPending(false);
  }, []);
  const { denied, begin, verify, accessFailure } = usePortabilityLifetime(
    apiClient,
    userId,
    workspace.id,
    clear,
  );
  const versionId = source.kind === 'version' ? source.versionId : undefined;
  useEffect(() => {
    if (denied) return;
    const request = begin();
    activeRequestRef.current = request;
    async function readSource(): Promise<ReviewedSource> {
      clear();
      setPending(true);
      await verify({ signal: request.signal, creating: false });
      request.signal.throwIfAborted();
      const saved = await readWorkflowExportSource({
        apiClient,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        source:
          versionId === undefined
            ? { kind: 'draft' }
            : { kind: 'version', versionId },
        signal: request.signal,
      });
      return { ...saved, digest: await portableGraphDigest(saved.graph) };
    }
    void readSource()
      .then(
        (saved) => {
          if (request.current()) setReview(saved);
        },
        (failure: unknown) => {
          if (request.current() && !accessFailure(failure))
            setError(describeCommandError(failure, 'reading the saved source'));
        },
      )
      .finally(() => {
        request.done();
        if (activeRequestRef.current === request) {
          activeRequestRef.current = undefined;
          if (request.current()) setPending(false);
        }
      });
    return () => {
      request.cancel();
      activeRequestRef.current?.cancel();
      activeRequestRef.current = undefined;
    };
  }, [
    apiClient,
    workspace.id,
    workflow.id,
    versionId,
    denied,
    begin,
    verify,
    accessFailure,
    clear,
    readAttempt,
  ]);
  return {
    state: { review, acknowledgedDigest, pending, error, denied },
    requests: { activeRequestRef, begin, verify, accessFailure },
    controls: {
      setPending,
      setError,
      setAcknowledgedDigest,
      setReview,
      setReadAttempt,
    },
  };
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
