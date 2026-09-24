import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { WorkspaceCreationDialog } from './components/creation/workspace-creation-dialog';
import { WorkspaceChooser } from './components/selection/workspace-chooser';
import { WorkspaceOnboarding } from './components/selection/workspace-onboarding';
import { WorkspaceSessionHeader } from './components/selection/workspace-session-header';
import './workspace-selection.css';

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
  const openCreation = () => {
    setCreationOpen(true);
  };

  return (
    <main id="main" className="app-stage min-h-svh px-5 sm:px-8">
      <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col">
        <WorkspaceSessionHeader
          email={user.email}
          logoutPending={logoutPending}
          onLogout={onLogout}
        />

        {logoutError ? (
          <p
            role="alert"
            className="workspace-logout-error text-sm text-destructive"
          >
            {logoutError}
          </p>
        ) : null}

        <div className="workspace-selection-content">
          {workspaces.length === 0 ? (
            <WorkspaceOnboarding onCreate={openCreation} />
          ) : (
            <WorkspaceChooser
              workspaces={workspaces}
              onCreate={openCreation}
              onSelect={onSelect}
            />
          )}
        </div>
        <WorkspaceCreationDialog
          key={user.id}
          apiClient={apiClient}
          userId={user.id}
          open={creationOpen}
          onOpenChange={setCreationOpen}
          onCreated={onCreated}
          onSessionInvalidated={() => {
            setCreationOpen(false);
            onSessionInvalidated();
          }}
        />
      </div>
    </main>
  );
}
