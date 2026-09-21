import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  GlassSection,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import type { ApiClient } from '@/lib/api/client';
import { WorkspaceCreationDialog } from './components/creation/workspace-creation-dialog';
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

const workspaceStatusCopy = Object.freeze({
  active: 'Ready',
  suspended: 'Suspended',
  pending_deletion: 'Deletion pending',
});

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
  return (
    <main id="main" className="app-stage min-h-svh px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
        <header className="flex flex-col gap-6 border-b border-white/8 pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs tracking-[0.2em] text-secondary">
              PERTEXO / WORKSPACE ACCESS
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Choose your workspace
            </h1>
            <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">
              Workspaces keep workflows, connections, and runs inside one
              operational boundary.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {workspaces.length === 0 ? null : (
              <Button
                type="button"
                variant="solid"
                onClick={() => {
                  setCreationOpen(true);
                }}
              >
                Create workspace
              </Button>
            )}
            <div className="min-w-0 text-right">
              <p className="truncate text-sm font-semibold">
                {user.displayName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={logoutPending}
              onClick={onLogout}
            >
              {logoutPending ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </header>

        {logoutError ? (
          <p role="alert" className="text-sm text-destructive">
            {logoutError}
          </p>
        ) : null}

        {workspaces.length === 0 ? (
          <GlassSection aria-labelledby="empty-workspaces-title">
            <GlassSectionHeader>
              <GlassSectionTitle id="empty-workspaces-title">
                No workspace access yet
              </GlassSectionTitle>
              <GlassSectionDescription>
                Create your first workspace to start building workflows, or ask
                an owner to add you to an existing one.
              </GlassSectionDescription>
            </GlassSectionHeader>
            <div className="px-6 pb-7 sm:px-8">
              <Button
                type="button"
                variant="solid"
                onClick={() => {
                  setCreationOpen(true);
                }}
              >
                Create your first workspace
              </Button>
            </div>
          </GlassSection>
        ) : (
          <section aria-label="Available workspaces" className="workspace-list">
            {workspaces.map((workspace) => {
              const available =
                workspace.status === 'active' ||
                (workspace.status === 'pending_deletion' &&
                  workspace.capabilities.includes('workspace:manage'));
              return (
                <button
                  key={workspace.id}
                  type="button"
                  className="workspace-entry group"
                  disabled={!available}
                  aria-describedby={`workspace-${workspace.id}-detail`}
                  onClick={() => {
                    onSelect(workspace);
                  }}
                >
                  <span className="workspace-entry-index" aria-hidden="true">
                    {workspace.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="workspace-entry-identity min-w-0 flex-1 text-left">
                    <span className="block [overflow-wrap:anywhere] font-heading text-xl font-semibold sm:truncate">
                      {workspace.name}
                    </span>
                    <span
                      id={`workspace-${workspace.id}-detail`}
                      className="mt-1 block [overflow-wrap:anywhere] text-sm text-muted-foreground sm:truncate"
                    >
                      {workspace.slug} / {workspace.role}
                    </span>
                  </span>
                  <span className="workspace-entry-status">
                    {workspace.status === 'pending_deletion' && available
                      ? 'Open recovery'
                      : workspaceStatusCopy[workspace.status]}
                  </span>
                </button>
              );
            })}
          </section>
        )}
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
