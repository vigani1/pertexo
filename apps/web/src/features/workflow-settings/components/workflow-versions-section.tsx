import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import type { WorkflowVersionsResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { useWorkflowVersionRestore } from '../mutations/use-workflow-settings-commands';
import {
  SettingsQueryState,
  SettingsSection,
  type SettingsQuery,
} from './settings-section';
import { visibleSettingsData } from './settings-query';

export function WorkflowVersionsSection({
  apiClient,
  userId,
  workspace,
  workflowId,
  query,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  query: SettingsQuery<WorkflowVersionsResponse>;
}>) {
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const canRestore = workspace.capabilities.includes('workflow:update');
  const versionRestore = useWorkflowVersionRestore({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const data = visibleSettingsData(query);

  async function restore() {
    if (!selectedVersionId) return;
    const version = data?.items.find(
      (candidate) => candidate.id === selectedVersionId,
    );
    if (version !== undefined && (await versionRestore.restore(version)))
      setSelectedVersionId(undefined);
  }

  return (
    <SettingsSection
      id="workflow-versions"
      title="Published versions"
      description="Immutable published graphs. Restoring one replaces the draft only; it does not republish."
    >
      <SettingsQueryState query={query} />
      {data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No version has been published.
        </p>
      ) : null}
      <ul className="divide-y">
        {data?.items.map((version) => (
          <li
            key={version.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p className="font-medium">
                Version {String(version.versionNumber)}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {version.id}
              </p>
            </div>
            {canRestore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  versionRestore.dismiss();
                  setSelectedVersionId(version.id);
                }}
              >
                Restore to draft
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Dialog
        open={data !== undefined && selectedVersionId !== undefined}
        onOpenChange={(open) => {
          if (!open && !versionRestore.pending) {
            versionRestore.dismiss();
            setSelectedVersionId(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Replace the current draft?</DialogTitle>
          <DialogDescription>
            {versionRestore.recovery === 'confirm-replacement'
              ? 'Another draft version now exists. Review it before explicitly confirming a new replacement command.'
              : 'The draft precondition is captured once. An uncertain result is checked before the same conditional command can be retried.'}
          </DialogDescription>
          {versionRestore.error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {versionRestore.error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={versionRestore.pending}
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              disabled={versionRestore.pending}
              onClick={() => void restore()}
            >
              {versionRestore.pending
                ? 'Restoring…'
                : versionRestore.recovery === 'check-outcome'
                  ? 'Check restore outcome'
                  : versionRestore.recovery === 'retry-original'
                    ? 'Retry original restore'
                    : versionRestore.recovery === 'confirm-replacement'
                      ? 'Replace newer draft'
                      : 'Restore draft'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
