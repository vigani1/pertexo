import { isWorkspaceBrowsable } from '@/features/workspaces/public';
import { useState } from 'react';
import {
  WorkflowExportDialog,
  WorkflowDuplicateDialog,
} from '@/features/workflows/workflows-views.public';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowSummary,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { canDuplicateWorkflow } from '@/features/workflows/public';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/patterns/states/empty';
import { workflowSummaryQueryOptions } from '@/features/workflows/workflows-queries.public';
import type { ApiClient } from '@/lib/api/client';
import { ListDetail } from '@/components/patterns/lists/list-detail';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../components/settings-read-failure';
import { RestoreVersionDialog } from '../components/versions/restore-dialog';
import { VersionCompareSheet } from '../components/versions/compare-sheet';
import { VersionPreviewSheet } from '../components/versions/preview-sheet';
import { VersionDetail } from '../components/versions/version-detail';
import { VersionList } from '../components/versions/version-list';
import {
  previousVersion,
  shownVersion,
  type HistoryVersion,
} from '../model/versions/history';
import { workflowVersionHistoryQueryOptions } from '../data/workflow-settings.queries';
import { shownData } from '@/lib/api/error-copy';

type Version = HistoryVersion;

type VersionOverlay =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'compare'; from?: Version; to?: Version }>
  | Readonly<{
      kind: 'preview' | 'restore' | 'duplicate' | 'export';
      version: Version;
    }>;

function NothingPublished({
  workspaceId,
  workflowId,
}: Readonly<{ workspaceId: string; workflowId: string }>) {
  return (
    <Empty spacing="flush">
      <EmptyTitle size="panel">Nothing published yet</EmptyTitle>
      <EmptyDescription>
        Publish from Build to create the first version. Each publish adds one
        here.
      </EmptyDescription>
      <EmptyActions>
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId, workflowId }}
          className={buttonVariants({ variant: 'primary' })}
        >
          Open Build
        </Link>
      </EmptyActions>
    </Empty>
  );
}

/** The draft and every published version beside the chosen one's detail. */
export function WorkflowVersionsPage({
  apiClient,
  user,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const versions = useQuery(
    workflowVersionHistoryQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId,
    ),
  );
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const [overlay, setOverlay] = useState<VersionOverlay>({ kind: 'none' });
  const [chosen, setChosen] = useState<
    Readonly<{ id: string | undefined; showing: 'list' | 'detail' }>
  >({ id: undefined, showing: 'list' });
  const workflow = shownData(summary);
  const canRestore = workspace.capabilities.includes('workflow:update');
  const items = shownData(versions)?.items;
  const liveVersionId = summary.data?.publishedVersionId ?? null;
  const archived = summary.data?.lifecycleStatus === 'archived';
  const liveLabel = archived ? 'Current' : 'Live';

  return (
    <>
      <QueryView
        query={versions}
        resource="Versions"
        failure={settingsReadFailure}
        isEmpty={(listed) => listed.items.length === 0}
        empty={
          <NothingPublished
            workspaceId={workspace.id}
            workflowId={workflowId}
          />
        }
      >
        {(listed) => {
          const shown = shownVersion(listed.items, chosen.id, liveVersionId);
          const live = listed.items.find(
            (version) => version.id === liveVersionId,
          );
          const comparison =
            live ?? listed.items.find((version) => version.id !== shown?.id);
          return (
            <ListDetail
              showing={chosen.showing}
              backLabel="All versions"
              onBack={() => {
                setChosen({ id: chosen.id, showing: 'list' });
              }}
              list={
                <VersionList
                  versions={listed.items}
                  liveVersionId={liveVersionId}
                  liveLabel={liveLabel}
                  selectedId={shown?.id}
                  onSelect={(version) => {
                    setChosen({ id: version.id, showing: 'detail' });
                  }}
                  draftLink={{ workspaceId: workspace.id, workflowId }}
                />
              }
              detail={
                shown === undefined ? null : (
                  <VersionDetail
                    version={shown}
                    previous={previousVersion(listed.items, shown)}
                    newer={listed.items
                      .filter(
                        (version) =>
                          version.versionNumber > shown.versionNumber,
                      )
                      .at(-1)}
                    live={live}
                    liveLabel={liveLabel}
                    actions={{
                      onPreview: (version) => {
                        setOverlay({ kind: 'preview', version });
                      },
                      onRestore: canRestore
                        ? (version) => {
                            setOverlay({ kind: 'restore', version });
                          }
                        : undefined,
                      onCompare:
                        comparison === undefined || listed.items.length < 2
                          ? undefined
                          : (version) => {
                              // Older first, so the changes read forwards.
                              const [from, to] =
                                version.versionNumber < comparison.versionNumber
                                  ? [version, comparison]
                                  : [comparison, version];
                              setOverlay({ kind: 'compare', from, to });
                            },
                      promotionWorkspaceId: canRestore
                        ? workspace.id
                        : undefined,
                      onExport:
                        isWorkspaceBrowsable(workspace) &&
                        workspace.capabilities.includes('workflow:read')
                          ? (version) => {
                              setOverlay({ kind: 'export', version });
                            }
                          : undefined,
                      onDuplicate:
                        workflow !== undefined &&
                        canDuplicateWorkflow(workspace, workflow)
                          ? (version) => {
                              setOverlay({ kind: 'duplicate', version });
                            }
                          : undefined,
                    }}
                  />
                )
              }
            />
          );
        }}
      </QueryView>
      <VersionOverlayContent
        overlay={overlay}
        onChange={setOverlay}
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        workflow={workflow}
        versions={items}
      />
    </>
  );
}

/** One overlay selection prevents simultaneous preview/copy/export owners. */
function VersionOverlayContent({
  overlay,
  onChange,
  apiClient,
  userId,
  workspace,
  workflowId,
  workflow,
  versions,
}: Readonly<{
  overlay: VersionOverlay;
  onChange: (overlay: VersionOverlay) => void;
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  versions: readonly Version[] | undefined;
}>) {
  const navigate = useNavigate();
  const close = () => {
    onChange({ kind: 'none' });
  };
  switch (overlay.kind) {
    case 'none':
      return null;
    case 'compare':
      return (
        <VersionCompareSheet
          open={versions !== undefined}
          versions={versions ?? []}
          {...(overlay.from === undefined || overlay.to === undefined
            ? {}
            : { pair: { from: overlay.from, to: overlay.to } })}
          onClose={close}
        />
      );
    case 'preview':
      return (
        <VersionPreviewSheet
          version={versions === undefined ? undefined : overlay.version}
          previous={versions?.find(
            (candidate) =>
              candidate.versionNumber < overlay.version.versionNumber,
          )}
          canRestore={workspace.capabilities.includes('workflow:update')}
          onRestore={() => {
            onChange({ kind: 'restore', version: overlay.version });
          }}
          onClose={close}
        />
      );
    case 'restore':
      return versions === undefined ? null : (
        <RestoreVersionDialog
          key={overlay.version.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          workflowId={workflowId}
          version={overlay.version}
          onClose={close}
        />
      );
    case 'duplicate':
      return workflow === undefined ? null : (
        <WorkflowDuplicateDialog
          key={`${userId}:${workspace.id}:${workflowId}:${overlay.version.id}`}
          workflow={workflow}
          source={{ kind: 'version', versionId: overlay.version.id }}
          versionNumber={overlay.version.versionNumber}
          allowed={versions !== undefined}
          onClose={close}
          onCreated={(destinationId) => {
            close();
            void navigate({
              to: '/w/$workspaceId/workflows/$workflowId',
              params: { workspaceId: workspace.id, workflowId: destinationId },
            });
          }}
          scope={{ apiClient, userId, workspace: workspace }}
        />
      );
    case 'export':
      return workflow === undefined ? null : (
        <WorkflowExportDialog
          key={`${userId}:${workspace.id}:${workflowId}:${overlay.version.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={workflow}
          source={{ kind: 'version', versionId: overlay.version.id }}
          allowed={versions !== undefined}
          onClose={close}
        />
      );
  }
}
