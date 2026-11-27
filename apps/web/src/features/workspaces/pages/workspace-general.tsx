import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useState, type ReactNode } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import type { ApiClient } from '@/lib/api/client';
import { formatDate, formatDateTime } from '@/lib/format/time';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import {
  DangerZone,
  WorkspaceLifecycleControls,
} from '../components/settings/workspace-danger-zone';
import { WorkspaceLeave } from '../components/settings/workspace-leave';
import { WorkspaceNameField } from '../components/settings/workspace-name-field';
import { WorkspaceAccess } from '../components/settings/workspace-access';
import { WorkspaceMark } from '../components/shell/workspace-mark';
import { ROLE_SUMMARIES, withArticle } from '../model/workspace-roles';

/**
 * Workspace settings: its identity (the name edited in place), what lives in
 * it, what your role lets you do, then deleting and leaving behind a clearly
 * fenced danger zone.
 */
export function WorkspaceGeneralPage({
  apiClient,
  user,
  workspace,
  onWorkspaceChanged,
  onLeft,
  assistantSettings,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  assistantSettings?: ReactNode;
  onWorkspaceChanged: () => void | Promise<void>;
  /** The person left; their sessions have ended. */
  onLeft: () => void | Promise<void>;
}>) {
  const canManage = workspace.capabilities.includes('workspace:manage');
  // The name as it's being typed: the mark is woven from it live.
  const [draftName, setDraftName] = useState<string>();
  const markName =
    draftName === undefined || draftName.trim() === ''
      ? workspace.name
      : draftName.trim();
  return (
    <div className="flex max-w-190 flex-col gap-11">
      <header className="flex items-center gap-5">
        <WorkspaceMark
          name={markName}
          size="preview"
          editing={draftName !== undefined}
        />
        <div className="min-w-0">
          <p className="font-mono text-micro tracking-[0.08em] text-subtle-foreground uppercase">
            Workspace
          </p>
          <h1 className="mt-1 font-display text-4xl leading-tight wrap-anywhere sm:text-display">
            {workspace.name}
          </h1>
          <p className="mt-2 font-mono text-caption wrap-anywhere text-subtle-foreground">
            {workspace.slug} · {workspace.id.slice(0, 8)}… · created{' '}
            <time
              dateTime={workspace.createdAt}
              title={formatDateTime(workspace.createdAt)}
            >
              {formatDate(workspace.createdAt)}
            </time>{' '}
            · you’re {withArticle(workspace.role)}
          </p>
        </div>
      </header>

      <SettingsGroup title="How it’s known">
        <SettingRow
          title="Name"
          description="Everyone in the workspace sees it. Edited in place."
        >
          <WorkspaceNameField
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            nameClassName="text-sm font-semibold wrap-anywhere"
            onDraftChange={setDraftName}
            onWorkspaceChanged={() => {
              void onWorkspaceChanged();
            }}
          />
        </SettingRow>
        <SettingRow
          title="URL slug"
          description="The address of every page in this workspace."
          action={
            <CopyButton
              value={workspace.slug}
              display={workspace.slug}
              label="Copy URL slug"
            />
          }
        />
        <SettingRow
          title="Workspace ID"
          description="What support and the API ask for."
          action={
            <CopyButton
              value={workspace.id}
              display={`${workspace.id.slice(0, 8)}…`}
              label="Copy workspace ID"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Your access">
        <SettingRow
          title={`You’re ${withArticle(workspace.role)}`}
          description={ROLE_SUMMARIES[workspace.role]}
          action={<WorkspaceAccess workspace={workspace} />}
        />
      </SettingsGroup>

      {assistantSettings}
      {canManage || workspace.status === 'active' ? (
        <DangerZone>
          {canManage ? (
            <WorkspaceLifecycleControls
              apiClient={apiClient}
              workspace={workspace}
              userId={user.id}
              onCompleted={onWorkspaceChanged}
            />
          ) : null}
          {workspace.status === 'active' ? (
            <WorkspaceLeave
              apiClient={apiClient}
              workspace={workspace}
              onLeft={onLeft}
            />
          ) : null}
        </DangerZone>
      ) : null}
    </div>
  );
}
