import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { workflowWorkspaceAccess } from '@/features/workflows/access.public';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { editorPresenceSource } from '../model/state/presence';
import { useEditorStoreApi } from '../model/state/context';
import { useEditorSessionVerification } from './use-editor-session-verification';
import { useEditorSavePipeline } from './use-editor-save-pipeline';
import { useLeaveGuard } from './use-leave-guard';

export function useEditorOwnership({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const store = useEditorStoreApi();
  const workflow = useQuery(
    workflowSummaryQueryOptions(apiClient, userId, workspace.id, workflowId),
  );
  const scopedWorkspace = workflowWorkspaceAccess(
    workspace,
    workflow.data?.resourceAccess,
  );
  const canUpdate = scopedWorkspace.capabilities.includes('workflow:update');
  const verification = useEditorSessionVerification({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const pauseReason = verification.pauseReason;
  const paused = pauseReason !== undefined;
  const presenceSource = useMemo(
    () => editorPresenceSource({ store, editing: canUpdate && !paused }),
    [store, canUpdate, paused],
  );
  const { flushSave, ensureSaved } = useEditorSavePipeline({
    apiClient,
    store,
    workspaceId: workspace.id,
    workflowId,
    canUpdate,
    paused,
    verifyOwner: verification.verifyOwner,
  });
  const guard = useLeaveGuard({ store, flushSave });
  return {
    workflow,
    access: { workspace: scopedWorkspace, canUpdate },
    verification,
    presenceSource,
    save: { flushSave, ensureSaved },
    guard,
  };
}
