import { QueryView } from '@/components/patterns/states/query-view';
import { publicationAction } from '../../model/publication/action';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { SuitePublishNotice } from '../test-suites/publish-notice';
import { PublishButton } from './publish-button';
import { PublishDialog } from './publish-dialog';
import { latestVersionQueryOptions } from '../../data/workflow-publish.queries';
import { reviewOverviewOptions } from '../../data/reviews/queries';
import type { ReviewScope } from '../../data/reviews/api';
import type {
  PublicationReceipt,
  WorkflowPublication,
} from '../../data/mutations/use-workflow-publication';
import type { WorkflowCommandSession } from '../../hooks/use-workflow-command-session';
import type { WorkflowIssuesView } from '../../model/validation/issues-state';
import type { WorkflowValidationTarget } from '../../model/validation/target';
import type { emptyDraftHint } from '../../model/publication/readiness';
import { summarizePublish } from '../../model/publication/summary';
import { unchangedLiveVersion } from '../../model/publication/unchanged';

function usePublishPreview({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  workflow,
  graph,
  receipt,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
  receipt: PublicationReceipt | undefined;
}>) {
  const everPublished =
    receipt !== undefined || (workflow?.publishedVersionId ?? null) !== null;
  const latest = useQuery({
    ...latestVersionQueryOptions(apiClient, userId, workspaceId, workflowId),
    enabled: everPublished,
  });
  const latestVersion = everPublished ? latest.data : null;
  const known = workflow !== undefined || receipt !== undefined;
  const summary =
    latestVersion === undefined || !known
      ? undefined
      : summarizePublish(graph, latestVersion);
  return {
    everPublished,
    summary,
    versionLabel:
      summary === undefined
        ? undefined
        : `v${String(summary.nextVersionNumber)}`,
    summaryState: summaryState({
      ready: summary !== undefined,
      loading: everPublished && latest.isPending,
    }),
  } as const;
}

function summaryState({
  ready,
  loading,
}: Readonly<{ ready: boolean; loading: boolean }>):
  'ready' | 'loading' | 'error' {
  if (ready) return 'ready';
  return loading ? 'loading' : 'error';
}

export function PublicationControls({
  scope,
  workflowId,
  publication,
  capabilities,
  onPublished,
  draft,
  validation,
}: Readonly<{
  scope: ReviewScope;
  workflowId: string;
  publication: WorkflowPublication;
  capabilities: AccessibleWorkspace['capabilities'];
  onPublished: (receipt: PublicationReceipt, hasTriggers: boolean) => void;
  draft: Readonly<{
    workflow: WorkflowSummary | undefined;
    graph: WorkflowGraphContract;
    revision: number;
    isSavedDraftCurrent: WorkflowCommandSession['isSavedDraftCurrent'];
    savedDraftCurrent: boolean;
  }>;
  validation: Readonly<{
    issues: WorkflowIssuesView;
    emptyHint: ReturnType<typeof emptyDraftHint>;
    onFix: (target: WorkflowValidationTarget) => void;
  }>;
}>) {
  const { workflow, graph, revision, isSavedDraftCurrent, savedDraftCurrent } =
    draft;

  const { issues, emptyHint, onFix } = validation;

  const { apiClient, userId, workspaceId } = scope;
  const [publishOpen, setPublishOpen] = useState(false);
  const navigate = useNavigate();
  const policy = useQuery({
    ...reviewOverviewOptions(scope, workflowId, revision),
    retry: false,
  });
  const { summary, versionLabel, ...preview } = usePublishPreview({
    apiClient,
    userId,
    workspaceId,
    workflowId,
    workflow,
    graph,
    receipt: publication.publicationReceipt,
  });
  const unchangedVersionNumber = unchangedLiveVersion(
    publication,
    workflow?.publishedVersionId,
    isSavedDraftCurrent,
  );
  const action = publicationAction({
    policy: policy.data,
    savedDraftCurrent,
    unchangedVersionNumber,
    versionLabel,
    emptyReason: emptyHint?.label,
    retry: publication.publishRecoveryPending
      ? (publication.recoveryCommand ?? 'publish')
      : undefined,
  });
  async function confirmPublish(note?: string) {
    if (action.unavailable) return;
    const result = await publication.publish(
      action.mode === 'review'
        ? { kind: 'review', note: note ?? '' }
        : { kind: 'publish' },
    );
    if (result.kind === 'published') {
      setPublishOpen(false);
      onPublished(result.receipt, (summary?.triggerNames.length ?? 0) > 0);
    } else if (result.kind === 'review_requested') {
      setPublishOpen(false);
      await navigate({
        to: '/w/$workspaceId/publish-reviews/$requestId',
        params: { workspaceId, requestId: result.request.id },
      });
    }
  }

  function open() {
    if (action.pendingReviewId !== undefined) {
      void navigate({
        to: '/w/$workspaceId/publish-reviews/$requestId',
        params: { workspaceId, requestId: action.pendingReviewId },
      });
      return;
    }
    publication.clearPublishError();
    setPublishOpen(true);
  }
  return (
    <>
      <PublishButton
        label={action.label}
        {...(action.compactLabel === undefined
          ? {}
          : { compactLabel: action.compactLabel })}
        blockedReason={action.blockedReason}
        onClick={open}
      />
      <PublishDialog
        mode={action.mode}
        unavailable={action.unavailable}
        slots={{
          policyNotice: (
            <QueryView
              query={policy}
              resource="Publishing policy"
              loading={
                <p role="status" className="text-sm text-muted-foreground">
                  Checking publishing policy…
                </p>
              }
            />
          ),
          suiteNotice: (
            <SuitePublishNotice
              scope={{ apiClient, userId, workspaceId, workflowId }}
              savedDraftCurrent={savedDraftCurrent}
              enabled={publishOpen}
              capabilities={capabilities}
            />
          ),
        }}
        issues={{ blockingGroups: issues.blockingGroups, onFix }}
        command={{
          stage: publication.publishStage,
          error: publication.publishError,
          recoveryPending: publication.publishRecoveryPending,
          onPublish: (note) => void confirmPublish(note),
        }}
        preview={{
          versionLabel: versionLabel ?? 'this draft',
          summary,
          summaryState: preview.summaryState,
          graph,
          unchangedVersionNumber,
        }}
        state={{ open: publishOpen, onOpenChange: setPublishOpen }}
      />
    </>
  );
}
