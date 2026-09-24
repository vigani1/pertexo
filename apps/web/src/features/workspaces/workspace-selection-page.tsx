import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { WorkspaceCreationSheet } from './components/creation/workspace-creation-sheet';
import { WorkspaceFirstRun } from './components/selection/workspace-first-run';
import { WorkspaceGrid } from './components/selection/workspace-grid';
import { WorkspacePickerHeader } from './components/selection/workspace-picker-header';
import { readLastWorkspace } from './last-workspace';

type WorkspaceSelectionPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspaces: readonly AccessibleWorkspace[];
  logoutPending: boolean;
  logoutError?: string;
  onSelect: (workspace: AccessibleWorkspace) => void;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
  onLogout: () => void;
}>;

/**
 * The workspace picker: rarely seen, since "/" opens the last workspace. New
 * people create their first workspace inline; everyone else picks a card.
 */
export function WorkspaceSelectionPage({
  apiClient,
  user,
  workspaces,
  logoutPending,
  logoutError,
  onSelect,
  onCreated,
  onSessionInvalidated,
  onLogout,
}: WorkspaceSelectionPageProps) {
  const [creationOpen, setCreationOpen] = useState(false);
  const lastOpenedId = readLastWorkspace(user.id);

  return (
    <div className="relative isolate min-h-svh bg-background">
      <div className="ambient fixed -z-10" aria-hidden="true" />
      <div
        className="warp pointer-events-none fixed inset-0 -z-10"
        aria-hidden="true"
      />
      <WorkspacePickerHeader
        user={user}
        logoutPending={logoutPending}
        onLogout={onLogout}
      />
      <main
        id="main"
        className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-12 pb-20 sm:px-8 sm:pt-16"
      >
        {logoutError === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {logoutError}
          </p>
        )}
        {workspaces.length === 0 ? (
          <WorkspaceFirstRun
            key={user.id}
            apiClient={apiClient}
            userId={user.id}
            onCreated={onCreated}
            onSessionInvalidated={onSessionInvalidated}
          />
        ) : (
          <>
            <WorkspaceGrid
              workspaces={workspaces}
              lastOpenedId={lastOpenedId}
              onSelect={onSelect}
              onCreate={() => {
                setCreationOpen(true);
              }}
            />
            <WorkspaceCreationSheet
              key={user.id}
              apiClient={apiClient}
              userId={user.id}
              open={creationOpen}
              onOpenChange={setCreationOpen}
              onCreated={onCreated}
              onSessionInvalidated={onSessionInvalidated}
            />
          </>
        )}
      </main>
    </div>
  );
}
