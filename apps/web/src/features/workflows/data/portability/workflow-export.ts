import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowExportRequest,
  WorkflowSummary,
} from '@pertexo/contracts';
import { describeCommandError } from '@/lib/api/error-copy';
import { downloadPortableWorkflow } from '../../model/portability';
import { usePortabilityLifetime } from './portability-lifetime';
import type { ApiClient } from '@/lib/api/client';
import {
  exportWorkflow,
  readWorkflowExportSource,
} from './workflow-portability.api';

type ExportTarget = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  signal: AbortSignal;
}>;

/** The saved graph an export reviews: the draft, or one published version. */
function readExportSource(
  target: ExportTarget & Readonly<{ versionId: string | undefined }>,
) {
  const { versionId, ...rest } = target;
  return readWorkflowExportSource({
    ...rest,
    source:
      versionId === undefined
        ? { kind: 'draft' }
        : { kind: 'version', versionId },
  });
}

/**
 * Exports exactly the reviewed source: its digest, and for a draft its tag,
 * make the server refuse an export of a graph that changed since review.
 */
function exportReviewedWorkflow(
  target: ExportTarget &
    Readonly<{
      source: WorkflowExportRequest['source'];
      review: Readonly<{ digest: string; etag?: string }>;
    }>,
) {
  const { source, review, ...rest } = target;
  return exportWorkflow({
    ...rest,
    body: { source, reviewedGraphDigest: review.digest },
    etag: review.etag,
  });
}

export type ReviewedSource = Awaited<ReturnType<typeof readExportSource>> & {
  digest: string;
};

/**
 * One export dialog's conversation: read the saved source, keep what the
 * person reviewed and acknowledged, and export exactly that. Everything is
 * dropped when the session or workspace authority changes.
 */
export function useWorkflowExportSession({
  apiClient,
  userId,
  workspace,
  workflow,
  source,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  source: WorkflowExportRequest['source'];
}>) {
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
  const { denied, begin, accessFailure } = usePortabilityLifetime(
    userId,
    workspace.id,
    { clear },
  );
  const versionId = source.kind === 'version' ? source.versionId : undefined;
  useEffect(() => {
    if (denied) return;
    const request = begin();
    activeRequestRef.current = request;
    async function readSource(): Promise<ReviewedSource> {
      clear();
      setPending(true);
      request.signal.throwIfAborted();
      const saved = await readExportSource({
        apiClient,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        versionId,
        signal: request.signal,
      });
      return saved;
    }
    void readSource()
      .then(
        (saved) => {
          if (request.current()) setReview(saved);
        },
        (failure: unknown) => {
          if (request.current() && !accessFailure(failure, 'read'))
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
    accessFailure,
    clear,
    readAttempt,
  ]);
  async function exportReviewed(onExported: () => void) {
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
      const manifest = await exportReviewedWorkflow({
        apiClient,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        source,
        review,
        signal: request.signal,
      });
      // The session may have ended while the export was in flight.
      if (!request.current()) return;
      downloadPortableWorkflow(manifest);
      onExported();
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
  return {
    state: { review, acknowledgedDigest, pending, error, denied },
    /** Downloads the reviewed source, then calls `onExported`. */
    exportReviewed,
    controls: {
      setAcknowledgedDigest,
      /** Reads the saved source again after a failed read. */
      readAgain: () => {
        setPending(true);
        setReadAttempt((attempt) => attempt + 1);
      },
    },
  };
}
