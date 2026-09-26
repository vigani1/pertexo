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
  const [previewing, setPreviewing] = useState<WorkflowVersionResponse>();
  const [restoring, setRestoring] = useState<WorkflowVersionResponse>();
  const [comparing, setComparing] = useState(false);
  const canRestore = workspace.capabilities.includes('workflow:update');
  const items = visibleSettingsData(versions)?.items;
  const live = items?.find(
    (version) => version.id === summary.data?.publishedVersionId,
  );
  const previous = (version: WorkflowVersionResponse) =>
    items?.find((candidate) => candidate.versionNumber < version.versionNumber);

  return (
    <>
      <SettingsSection
        title="Versions"
        description={
          <>
            Each publish makes a version that never changes. Restoring one
            copies it into the draft.
            {live === undefined ? null : (
              <span className="mt-2 block font-mono text-xs text-subtle-foreground">
                {String(items?.length ?? 0)} published · v
                {String(live.versionNumber)} is{' '}
                {summary.data?.lifecycleStatus === 'archived'
                  ? 'current (archived)'
                  : 'live'}
              </span>
            )}
          </>
        }
      >
        <SettingsQueryState query={versions} resource="Versions" />
        {items?.length === 0 ? (
          <Empty className="border-t-0 py-2">
            <EmptyTitle className="text-xl">Nothing published yet</EmptyTitle>
            <EmptyDescription>
              Publish from Build to create the first version. Each publish adds
              one here.
            </EmptyDescription>
            <EmptyActions>
              <Link
                to="/w/$workspaceId/workflows/$workflowId"
                params={{ workspaceId: workspace.id, workflowId }}
                className={buttonVariants({ variant: 'primary' })}
              >
                Open Build
              </Link>
            </EmptyActions>
          </Empty>
        ) : null}
        {items === undefined || items.length < 2 ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              setComparing(true);
            }}
          >
            <GitCompareArrowsIcon aria-hidden="true" data-icon="inline-start" />
            Compare versions
          </Button>
        )}
        {items === undefined || items.length === 0 ? null : (
          <VersionTimeline
            versions={items}
            liveVersionId={summary.data?.publishedVersionId ?? null}
            liveLabel={
              summary.data?.lifecycleStatus === 'archived' ? 'Current' : 'Live'
            }
            canRestore={canRestore}
            onPreview={setPreviewing}
            onRestore={setRestoring}
          />
        )}
      </SettingsSection>
      <VersionCompareSheet
        open={comparing && items !== undefined}
        versions={items ?? []}
        onClose={() => {
          setComparing(false);
        }}
      />
      <VersionPreviewSheet
        version={items === undefined ? undefined : previewing}
        previous={previewing === undefined ? undefined : previous(previewing)}
        canRestore={canRestore}
        onRestore={(version) => {
          setPreviewing(undefined);
          setRestoring(version);
        }}
        onClose={() => {
          setPreviewing(undefined);
        }}
      />
      {restoring === undefined || items === undefined ? null : (
        <RestoreVersionDialog
          key={restoring.id}
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          workflowId={workflowId}
          version={restoring}
          onClose={() => {
            setRestoring(undefined);
          }}
        />
      )}
    </>
  );
}
