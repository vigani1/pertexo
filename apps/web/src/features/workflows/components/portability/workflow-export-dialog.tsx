import { useCallback, useEffect, useRef, useState } from 'react';
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
}: WorkflowExportDialogProps) {
  const [review, setReview] = useState<ReviewedSource>();
  const [acknowledgedDigest, setAcknowledgedDigest] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [readAttempt, setReadAttempt] = useState(0);
  const activeRequest = useRef<
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
    activeRequest.current = request;
    async function readSource(): Promise<ReviewedSource> {
      clear();
      setPending(true);
      await verify(request.signal, false);
      request.signal.throwIfAborted();
      const saved = await readWorkflowExportSource(
        apiClient,
        workspace.id,
        workflow.id,
        versionId === undefined
          ? { kind: 'draft' }
          : { kind: 'version', versionId },
        request.signal,
      );
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
        if (activeRequest.current === request) {
          activeRequest.current = undefined;
          if (request.current()) setPending(false);
        }
      });
    return () => {
      request.cancel();
      activeRequest.current?.cancel();
      activeRequest.current = undefined;
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
  async function download() {
    if (
      review === undefined ||
      acknowledgedDigest !== review.digest ||
      activeRequest.current !== undefined ||
      denied
    )
      return;
    const request = begin();
    activeRequest.current = request;
    setPending(true);
    setError(undefined);
    try {
      await verify(request.signal, false);
      if (!request.current()) return;
      const manifest = await exportWorkflow(
        apiClient,
        workspace.id,
        workflow.id,
        { source, reviewedGraphDigest: review.digest },
        'etag' in review ? review.etag : undefined,
        request.signal,
      );
      if (!request.current()) return;
      await verify(request.signal, false);
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
      if (activeRequest.current === request) {
        activeRequest.current = undefined;
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogTitle>Export workflow</DialogTitle>
        <DialogDescription>
          {denied
            ? 'Access changed. The reviewed source has been cleared.'
            : `Review the exact saved source of “${workflow.name}” before downloading it.`}
        </DialogDescription>
        {denied ? null : (
          <div className="mt-5 flex flex-col gap-4">
            <Notice tone="warning">
              Credentials and workspace connection references are excluded.
              Configuration, literals, labels and expressions may still contain
              secrets or private information. Nothing is automatically scrubbed.
              Inspect every value before sharing the file.
            </Notice>
            {review === undefined ? null : (
              <>
                <p className="font-mono text-xs text-muted-foreground">
                  {review.label}. Unsaved browser edits are not exported.
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
                      setAcknowledgedDigest(
                        checked ? review.digest : undefined,
                      );
                    }}
                  />
                  I reviewed this exact graph, including configuration and
                  expressions, and understand that private values may remain in
                  the download.
                </label>
              </>
            )}
          </div>
        )}
        {error === undefined ? null : (
          <Notice tone="destructive" className="mt-4">
            {error}
          </Notice>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowExportAction({
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
  if (!workspace.capabilities.includes('workflow:read')) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={blocked}
        title={
          blocked
            ? 'Save or resolve unfinished edits and conflicts before exporting the saved draft.'
            : undefined
        }
        onClick={() => {
          setOpen(true);
        }}
      >
        Export…
      </Button>
      {open ? (
        <WorkflowExportDialog
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
        />
      ) : null}
    </>
  );
}
