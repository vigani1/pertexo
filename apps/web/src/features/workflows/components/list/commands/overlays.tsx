import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { NewWorkflowSheet } from '../../creation/new-workflow-sheet';
import { WorkflowDuplicateDialog } from '../../workflow-duplicate-dialog';
import { WorkflowExportDialog } from '../../portability/workflow-export-dialog';
import { WorkflowImportDialog } from '../../portability/workflow-import-dialog';
import { WorkflowDialogs, type LifecycleTarget } from './dialogs';
import {
  updateWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../../../model/list-view';

type ListOverlaysProps = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
  creation: Readonly<{
    canCreate: boolean;
    search: WorkflowListSearch;
    onSearchChange: (search: WorkflowListSearchUpdate) => void | Promise<void>;
    onCreated: (workflowId: string) => void;
    chooseExample: (templateId: string, name?: string) => void;
  }>;
  selection: Readonly<{
    renaming: WorkflowSummary | undefined;
    lifecycle: LifecycleTarget | undefined;
    duplicating: WorkflowSummary | undefined;
    exporting: WorkflowSummary | undefined;
    importing: boolean;
    example: string | undefined;
    exampleName: string;
  }>;
  commands: Readonly<{
    setRenaming: (value: WorkflowSummary | undefined) => void;
    setLifecycle: (value: LifecycleTarget | undefined) => void;
    setDuplicating: (value: WorkflowSummary | undefined) => void;
    setExporting: (value: WorkflowSummary | undefined) => void;
    setImporting: (value: boolean) => void;
  }>;
}>;
export function WorkflowListOverlays({
  scope,
  creation,
  selection,
  commands,
}: ListOverlaysProps) {
  const { apiClient, userId, workspace } = scope;
  const { canCreate, search, onSearchChange, onCreated, chooseExample } =
    creation;
  const {
    renaming,
    lifecycle,
    duplicating,
    exporting,
    importing,
    example,
    exampleName,
  } = selection;
  const {
    setRenaming,
    setLifecycle,
    setDuplicating,
    setExporting,
    setImporting,
  } = commands;
  return (
    <>
      {canCreate ? (
        <NewWorkflowSheet
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          open={search.create ?? false}
          onOpenChange={(open) => {
            void onSearchChange(
              updateWorkflowListSearch(search, { create: open }),
            );
          }}
          onCreated={onCreated}
          onChooseExample={chooseExample}
        />
      ) : null}
      <WorkflowDialogs
        apiClient={apiClient}
        userId={userId}
        workspaceId={workspace.id}
        renaming={renaming}
        lifecycle={lifecycle}
        onRenameClose={() => {
          setRenaming(undefined);
        }}
        onLifecycleClose={() => {
          setLifecycle(undefined);
        }}
      />
      {duplicating === undefined ? null : (
        <WorkflowDuplicateDialog
          key={`${userId}:${workspace.id}:${duplicating.id}`}
          workflow={duplicating}
          source={{ kind: 'draft' }}
          onClose={() => {
            setDuplicating(undefined);
          }}
          onCreated={(workflowId) => {
            setDuplicating(undefined);
            onCreated(workflowId);
          }}
          scope={{ apiClient, userId, workspace: workspace }}
        />
      )}
      {exporting === undefined ? null : (
        <WorkflowExportDialog
          key={`${userId}:${workspace.id}:${exporting.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={exporting}
          source={{ kind: 'draft' }}
          onClose={() => {
            setExporting(undefined);
          }}
        />
      )}
      {/* A file import and each example keep their own session, so a
          retained file import isn't mixed with an example's setup. */}
      <WorkflowImportDialog
        key={`${userId}:${workspace.id}:${example ?? 'file'}:${exampleName}`}
        open={importing}
        example={example}
        initialName={exampleName}
        onReopen={() => {
          setImporting(true);
        }}
        onClose={() => {
          setImporting(false);
        }}
        onCreated={(id) => {
          setImporting(false);
          onCreated(id);
        }}
        scope={{ apiClient, userId, workspace: workspace }}
      />
    </>
  );
}
