import { useState } from 'react';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
import { visibleSettingsData } from './model/settings-query';
import { SettingsSection } from '@/components/patterns/settings-section';
import { SettingsQueryState } from './components/settings-section';
import { RestoreVersionDialog } from './components/versions/restore-version-dialog';
import { VersionCompareSheet } from './components/versions/version-compare-sheet';
import { VersionPreviewSheet } from './components/versions/version-preview-sheet';
import { VersionTimeline } from './components/versions/version-timeline';
import { workflowVersionsQueryOptions } from './workflow-settings.queries';

type Version = WorkflowVersionResponse;

/** Which overlay is open over the versions: a preview, compare or restore. */
function useVersionOverlays() {
  const [previewing, setPreviewing] = useState<Version>();
  const [restoring, setRestoring] = useState<Version>();
  const [comparing, setComparing] = useState(false);
  return {
    previewing,
    restoring,
    comparing,
    preview: setPreviewing,
    restore: setRestoring,
    compare: () => {
      setComparing(true);
    },
    /** From a preview straight to restoring the same version. */
    restoreFromPreview: (version: Version) => {
      setPreviewing(undefined);
      setRestoring(version);
    },
    closePreview: () => {
      setPreviewing(undefined);
    },
    closeRestore: () => {
      setRestoring(undefined);
    },
    closeCompare: () => {
      setComparing(false);
    },
  } as const;
}

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
}: Readonly<{
  items: readonly Version[];
  liveVersionId: string | null;
  archived: boolean;
  canRestore: boolean;
  onCompare: () => void;
  onPreview: (version: Version) => void;
  onRestore: (version: Version) => void;
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
  const overlays = useVersionOverlays();
  const canRestore = workspace.capabilities.includes('workflow:update');
  const items = visibleSettingsData(versions)?.items;
  const liveVersionId = summary.data?.publishedVersionId ?? null;
  const archived = summary.data?.lifecycleStatus === 'archived';
  const live = items?.find((version) => version.id === liveVersionId);
  const previous = (version: Version) =>
    items?.find((candidate) => candidate.versionNumber < version.versionNumber);

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
            onCompare={overlays.compare}
            onPreview={overlays.preview}
            onRestore={overlays.restore}
          />
        )}
      </SettingsSection>
      <VersionCompareSheet
        open={overlays.comparing && items !== undefined}
        versions={items ?? []}
        onClose={overlays.closeCompare}
      />
      <VersionPreviewSheet
        version={items === undefined ? undefined : overlays.previewing}
        previous={
          overlays.previewing === undefined
            ? undefined
            : previous(overlays.previewing)
        }
        canRestore={canRestore}
        onRestore={overlays.restoreFromPreview}
        onClose={overlays.closePreview}
      />
      {overlays.restoring === undefined || items === undefined ? null : (
        <RestoreVersionDialog
          key={overlays.restoring.id}
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          workflowId={workflowId}
          version={overlays.restoring}
          onClose={overlays.closeRestore}
        />
      )}
    </>
  );
}
