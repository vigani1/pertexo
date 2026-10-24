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
  workflow,
  graph,
  revision,
  publication,
  isSavedDraftCurrent,
  issues,
  emptyHint,
  savedDraftCurrent,
  capabilities,
  onFix,
  onPublished,
}: Readonly<{
  scope: ReviewScope;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
  revision: number;
  publication: WorkflowPublication;
  isSavedDraftCurrent: WorkflowCommandSession['isSavedDraftCurrent'];
  issues: WorkflowIssuesView;
  emptyHint: ReturnType<typeof emptyDraftHint>;
  savedDraftCurrent: boolean;
  capabilities: AccessibleWorkspace['capabilities'];
  onFix: (target: WorkflowValidationTarget) => void;
  onPublished: (receipt: PublicationReceipt, hasTriggers: boolean) => void;
}>) {
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
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionLabel={versionLabel ?? 'this draft'}
        mode={action.mode}
        unavailable={action.unavailable}
        policyNotice={
          <QueryView
            query={policy}
            resource="Publishing policy"
            loading={
              <p role="status" className="text-sm text-muted-foreground">
                Checking publishing policy…
              </p>
            }
          />
        }
        summary={summary}
        summaryState={preview.summaryState}
        graph={graph}
        stage={publication.publishStage}
        error={publication.publishError}
        recoveryPending={publication.publishRecoveryPending}
        blockingGroups={issues.blockingGroups}
        unchangedVersionNumber={unchangedVersionNumber}
        suiteNotice={
          <SuitePublishNotice
            scope={{ apiClient, userId, workspaceId, workflowId }}
            savedDraftCurrent={savedDraftCurrent}
            enabled={publishOpen}
            capabilities={capabilities}
          />
        }
        onPublish={(note) => void confirmPublish(note)}
        onFix={onFix}
      />
    </>
  );
}
