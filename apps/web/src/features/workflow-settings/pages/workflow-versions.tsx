import { useState } from 'react';
import { WorkflowExportDialog } from '@/features/workflows/creation/portability.public';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowVersionResponse,
  WorkflowSummary,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  WorkflowDuplicateDialog,
  canDuplicateWorkflow,
} from '@/features/workflows/creation/duplicate.public';
import { GitCompareArrowsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { visibleSettingsData } from '../model/settings-query';
import { SettingsSection } from '@/components/patterns/settings-section';
import { SettingsQueryState } from '../components/settings-query-state';
import { RestoreVersionDialog } from '../components/versions/restore-version-dialog';
import { VersionCompareSheet } from '../components/versions/compare-sheet';
import { VersionPreviewSheet } from '../components/versions/preview-sheet';
import { VersionTimeline } from '../components/versions/timeline';
import { workflowVersionsQueryOptions } from '../data/workflow-settings.queries';

type Version = WorkflowVersionResponse;

type VersionOverlay =
  | Readonly<{ kind: 'none' | 'compare' }>
  | Readonly<{
      kind: 'preview' | 'restore' | 'duplicate' | 'export';
      version: Version;
    }>;

/** "3 published · v3 is live", under the section's sentence. */
function VersionsTally({
  count,
  liveNumber,
  archived,
}: Readonly<{ count: number; liveNumber: number; archived: boolean }>) {
  return (
    <span className="mt-2 block font-mono text-xs text-subtle-foreground">
      {String(count)} published · v{String(liveNumber)} is{' '}
      {archived ? 'current (archived)' : 'live'}
    </span>
  );
}

function NothingPublished({
  workspaceId,
  workflowId,
}: Readonly<{ workspaceId: string; workflowId: string }>) {
  return (
    <Empty className="border-t-0 py-2">
      <EmptyTitle className="text-xl">Nothing published yet</EmptyTitle>
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

/** The section's sentence, and the tally once a version is live. */
function VersionsIntro({
  count,
  live,
  archived,
}: Readonly<{ count: number; live: Version | undefined; archived: boolean }>) {
  return (
    <>
      Each publish makes a version that never changes. Restoring one copies it
      into the draft.
      {live === undefined ? null : (
        <VersionsTally
          count={count}
          liveNumber={live.versionNumber}
          archived={archived}
        />
      )}
    </>
  );
}

/** The versions on their thread, with Compare once there are two. */
function VersionList({
  items,
  liveVersionId,
  archived,
  canRestore,
  onCompare,
  onPreview,
  onRestore,
  onDuplicate,
  onExport,
}: Readonly<{
  items: readonly Version[];
  liveVersionId: string | null;
  archived: boolean;
  canRestore: boolean;
  onCompare: () => void;
  onPreview: (version: Version) => void;
  onRestore: (version: Version) => void;
  onDuplicate: ((version: Version) => void) | undefined;
  onExport: ((version: Version) => void) | undefined;
}>) {
  return (
    <>
      {items.length < 2 ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onCompare}
        >
          <GitCompareArrowsIcon aria-hidden="true" data-icon="inline-start" />
          Compare versions
        </Button>
      )}
      <VersionTimeline
        versions={items}
        liveVersionId={liveVersionId}
        liveLabel={archived ? 'Current' : 'Live'}
        canRestore={canRestore}
        onPreview={onPreview}
        onRestore={onRestore}
        onDuplicate={onDuplicate}
        onExport={onExport}
      />
    </>
  );
}

/** Every published version on one thread, with preview, compare and restore. */
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
    workflowVersionsQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const [overlay, setOverlay] = useState<VersionOverlay>({ kind: 'none' });
  const workflow = visibleSettingsData(summary);
  const canRestore = workspace.capabilities.includes('workflow:update');
  const items = visibleSettingsData(versions)?.items;
  const liveVersionId = summary.data?.publishedVersionId ?? null;
  const archived = summary.data?.lifecycleStatus === 'archived';
  const live = items?.find((version) => version.id === liveVersionId);

  return (
    <>
      <SettingsSection
        title="Versions"
        description={
          <VersionsIntro
            count={items?.length ?? 0}
            live={live}
            archived={archived}
          />
        }
      >
        <SettingsQueryState query={versions} resource="Versions" />
        {items?.length === 0 ? (
          <NothingPublished
            workspaceId={workspace.id}
            workflowId={workflowId}
          />
        ) : null}
        {items === undefined || items.length === 0 ? null : (
          <VersionList
            items={items}
            liveVersionId={liveVersionId}
            archived={archived}
            canRestore={canRestore}
            onCompare={() => {
              setOverlay({ kind: 'compare' });
            }}
            onPreview={(version) => {
              setOverlay({ kind: 'preview', version });
            }}
            onRestore={(version) => {
              setOverlay({ kind: 'restore', version });
            }}
            onExport={
              workspace.capabilities.includes('workflow:read')
                ? (version) => {
                    setOverlay({ kind: 'export', version });
                  }
                : undefined
            }
            onDuplicate={
              workflow !== undefined &&
              canDuplicateWorkflow(workspace, workflow)
                ? (version) => {
                    setOverlay({ kind: 'duplicate', version });
                  }
                : undefined
            }
          />
        )}
      </SettingsSection>
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
          onRestore={(version) => {
            onChange({ kind: 'restore', version });
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
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
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
