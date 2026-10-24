import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  useWorkflowCommandSession,
  useAutoValidation,
} from '@/features/workflow-publish/public';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  workflowKeys,
  workflowOrganizationKeys,
} from '@/features/workflows/queries.public';
import { useEditorStore, useEditorStoreApi } from '../model/state/context';
import { workflowConnectionIssues } from '../model/connection-issues';
import { workflowPlaceholderIssues } from '../model/inspector/http-body';
import { useIssuesView } from './use-issues-view';
import type { useEditorSessionVerification } from './use-editor-session-verification';
import type { useEditorSavePipeline } from './use-editor-save-pipeline';

type PublicationInput = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
    workflowId: string;
  }>;
  verification: ReturnType<typeof useEditorSessionVerification>;
  ensureSaved: ReturnType<typeof useEditorSavePipeline>['ensureSaved'];
  paused: boolean;
  onRunAccepted: (runId: string) => void;
  onPublished: (() => void) | undefined;
  catalog: Readonly<{
    definitions: readonly NodeDefinitionCatalogItem[];
    connections: readonly ConnectionResponse[];
    connectionsAvailable: boolean;
  }>;
}>;
export function useEditorPublication({
  scope,
  verification,
  ensureSaved,
  paused,
  onRunAccepted,
  onPublished,
  catalog,
}: PublicationInput) {
  const { apiClient, userId, workspaceId, workflowId } = scope;
  const { definitions, connections, connectionsAvailable } = catalog;
  const store = useEditorStoreApi();
  const queryClient = useQueryClient();
  const graph = useEditorStore((state) => state.graph);
  const generation = useEditorStore((state) => state.generation);
  const revision = useEditorStore((state) => state.revision);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const inspectorScratch = useEditorStore((state) => state.inspectorScratch);
  const commandSession = useWorkflowCommandSession({
    apiClient,
    userId,
    workspaceId: workspaceId,
    workflowId,
    verifyIdentity: verification.verifyOwner,
    isSessionPaused: verification.isPaused,
    ensureSaved,
    isSavedDraftCurrent: (saved) => {
      const current = store.getState();
      const savedDraftIsCurrent =
        !verification.isPaused() &&
        current.saveStatus === 'clean' &&
        !current.inspectorScratch &&
        current.etag === saved.etag &&
        current.generation === saved.generation &&
        current.revision === saved.revision;
      return savedDraftIsCurrent;
    },
    onRunAccepted,
    onRunCommandAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
    },
    onPublicationAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
      onPublished?.();
    },
  });
  const { publication } = commandSession;
  const autoValidation = useAutoValidation({
    publication,
    enabled: !paused,
    saveStatus,
    inspectorScratch,
    revision,
    generation,
  });
  const connectionIssues = useMemo(
    () => [
      ...workflowConnectionIssues({
        graph,
        definitions,
        connections,
        available: connectionsAvailable,
      }),
      ...workflowPlaceholderIssues(graph),
    ],
    [graph, definitions, connections, connectionsAvailable],
  );
  const issues = useIssuesView(
    publication,
    graph,
    { generation, revision },
    connectionIssues,
  );
  return {
    commandSession,
    publication,
    autoValidation,
    issues,
    draft: { graph, generation, revision, saveStatus, inspectorScratch },
  };
}
