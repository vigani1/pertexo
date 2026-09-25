import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { CoreOrb } from '@/components/patterns/core-orb';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceCreation } from '../../mutations/use-workspace-creation';
import { WorkspaceCreationForm } from '../creation/workspace-creation-form';

/** No workspaces yet: create the first one right here, no dialog. */
export function WorkspaceFirstRun({
  apiClient,
  userId,
  onCreated,
  onSessionInvalidated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
}>) {
  const [formKey, setFormKey] = useState(0);
  const command = useWorkspaceCreation({
    apiClient,
    userId,
    onCreated,
    onSessionInvalidated,
  });

  return (
    <section
      aria-labelledby="first-workspace-title"
      className="mx-auto flex w-full max-w-md flex-col"
    >
      <CoreOrb state="idle" className="-ml-4 size-28" />
      <h1
        id="first-workspace-title"
        className="mt-2 font-display text-4xl leading-[0.95] sm:text-5xl"
      >
        Create your workspace
      </h1>
      <p className="mt-3 leading-relaxed text-muted-foreground">
        A workspace keeps your team’s workflows, connections and runs together.
        You’ll be its owner.
      </p>
      <div className="mt-8 rounded-xl border border-border bg-card/60 p-5 sm:p-6">
        <WorkspaceCreationForm
          key={formKey}
          idPrefix="workspace-first"
          command={command}
          onStartOver={() => {
            setFormKey((key) => key + 1);
          }}
        />
      </div>
      <p className="mt-6 text-sm text-subtle-foreground">
        Joining a team? Open the invite link from your email.
      </p>
    </section>
  );
}
