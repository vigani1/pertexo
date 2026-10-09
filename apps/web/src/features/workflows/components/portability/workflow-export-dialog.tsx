import { useCallback, useEffect, useRef, useState } from 'react';
import {
  portableGraphDigest,
  type WorkflowExportRequest,
} from '@pertexo/contracts';
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
import { describeCommandError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  exportWorkflow,
  readWorkflowExportSource,
} from '../../data/workflow-portability.api';
import { downloadPortableWorkflow } from '../../model/workflow-portability';
import { usePortabilityLifetime } from './use-portability-lifetime';
import { PortableGraphReview } from './portable-graph-review';

type ReviewedSource = Awaited<ReturnType<typeof readWorkflowExportSource>> & {
  digest: string;
};

export function WorkflowExportDialog({
  apiClient,
  userId,
  workspace,
  workflow,
  source,
  allowed = true,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  source: WorkflowExportRequest['source'];
  allowed?: boolean;
  onClose: () => void;
}>) {
  const [review, setReview] = useState<ReviewedSource>();
  const [acknowledgedDigest, setAcknowledgedDigest] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
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
    allowed && workspace.capabilities.includes('workflow:read'),
    clear,
  );
  const kind = source.kind;
  const versionId = source.kind === 'version' ? source.versionId : undefined;
  const read = useCallback(async () => {
    if (busy.current || denied) return;
    busy.current = true;
    clear();
    setPending(true);
    const request = begin();
    try {
      if (!(await verify(request.signal, false)) || !request.current()) return;
      const saved = await readWorkflowExportSource(
        apiClient,
        workspace.id,
        workflow.id,
        kind === 'draft' ? { kind } : { kind, versionId: versionId ?? '' },
        request.signal,
      );
      const digest = await portableGraphDigest(saved.graph);
      if (request.current()) setReview({ ...saved, digest });
    } catch (failure) {
      if (request.current() && !accessFailure(failure))
        setError(describeCommandError(failure, 'reading the saved source'));
    } finally {
      request.done();
      busy.current = false;
      if (request.current()) setPending(false);
    }
  }, [
    apiClient,
    workspace.id,
    workflow.id,
    kind,
    versionId,
    denied,
    begin,
    verify,
    accessFailure,
    clear,
  ]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted && !denied) void read();
    });
    return () => {
      mounted = false;
    };
  }, [read, denied]);
  async function download() {
    if (
      review === undefined ||
      acknowledgedDigest !== review.digest ||
      busy.current ||
      denied
    )
      return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const request = begin();
    try {
      if (!(await verify(request.signal, false)) || !request.current()) return;
      const manifest = await exportWorkflow(
        apiClient,
        workspace.id,
        workflow.id,
        { source, reviewedGraphDigest: review.digest },
        'etag' in review ? review.etag : undefined,
        request.signal,
      );
      if (
        !request.current() ||
        !(await verify(request.signal, false)) ||
        !request.current()
      )
        return;
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
      busy.current = false;
      if (request.current()) setPending(false);
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
            <Button variant="outline" onClick={() => void read()}>
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
