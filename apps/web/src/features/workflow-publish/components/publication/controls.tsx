import { useState } from 'react';
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

/**
 * What publishing would change and the version it would make, once the
 * latest version (or that there is none) and the workflow are known.
 */
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
    summaryState: summaryState(
      summary !== undefined,
      everPublished && latest.isPending,
    ),
  } as const;
}

function summaryState(
  ready: boolean,
  loading: boolean,
): 'ready' | 'loading' | 'error' {
  if (ready) return 'ready';
  return loading ? 'loading' : 'error';
}

export function PublicationControls({
  scope,
  workflowId,
  workflow,
  graph,
  publication,
  isSavedDraftCurrent,
  issues,
  emptyHint,
  savedDraftCurrent,
  capabilities,
  canPublish,
  onFix,
  onPublished,
}: Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
  }>;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
  publication: WorkflowPublication;
  isSavedDraftCurrent: WorkflowCommandSession['isSavedDraftCurrent'];
  issues: WorkflowIssuesView;
  emptyHint: ReturnType<typeof emptyDraftHint>;
  savedDraftCurrent: boolean;
  capabilities: AccessibleWorkspace['capabilities'];
  canPublish: boolean;
  onFix: (target: WorkflowValidationTarget) => void;
  onPublished: (receipt: PublicationReceipt, hasTriggers: boolean) => void;
}>) {
  const { apiClient, userId, workspaceId } = scope;
  const [publishOpen, setPublishOpen] = useState(false);
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
  const unchangedReason =
    unchangedVersionNumber === undefined
      ? undefined
      : `No changes since v${String(unchangedVersionNumber)}`;
  async function confirmPublish() {
    const result = await publication.publish();
    if (result.kind !== 'published') return;
    setPublishOpen(false);
    onPublished(result.receipt, (summary?.triggerNames.length ?? 0) > 0);
  }
  return (
    <>
      {canPublish ? (
        <PublishButton
          {...(unchangedVersionNumber === undefined
            ? {}
            : {
                compactLabel: 'No changes',
              })}
          label={
            unchangedReason ??
            (versionLabel === undefined ? 'Publish' : `Publish ${versionLabel}`)
          }
          blockedReason={unchangedReason ?? emptyHint?.label}
          onClick={() => {
            publication.clearPublishError();
            setPublishOpen(true);
          }}
        />
      ) : null}
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        versionLabel={versionLabel ?? 'this draft'}
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
            scope={{ apiClient, userId, workspaceId: workspaceId, workflowId }}
            savedDraftCurrent={savedDraftCurrent}
            enabled={publishOpen}
            capabilities={capabilities}
          />
        }
        onPublish={() => void confirmPublish()}
        onFix={onFix}
      />
    </>
  );
}
