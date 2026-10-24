import type { EditorPresenceSource } from '../model/state/presence';
import type {
  ConnectionResponse,
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import { editorConnectionsQueryOptions } from '@/features/connections/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { EditorProvider } from '../model/state/provider';
import { workflowDraftQueryOptions } from '../data/workflow-editor.queries';
import { StepDiscussionsContext } from '../model/state/discussions';
import { WorkflowEditorSession } from '../components/session';

const NO_CONNECTIONS: readonly ConnectionResponse[] = [];

const NO_DISCUSSIONS: ReadonlyMap<string, number> = new Map();

export function WorkflowEditorPage({
  apiClient,
  user,
  workspace,
  workflowId,
  onRunAccepted,
  onPublished,
  triggerNotice,
  headerPresence,
  renderEditingPresence,
  stepDiscussions,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  /** Open discussions about each step, shown on its card. */
  stepDiscussions?: ReadonlyMap<string, number>;
  onRunAccepted: (runId: string) => void;
  /** After a publish lands, for reads of the workflow outside the editor. */
  onPublished?: () => void;
  triggerNotice?: ReactNode;
  headerPresence?: ReactNode;
  renderEditingPresence?: (source: EditorPresenceSource) => ReactNode;
}>) {
  const draft = useSuspenseQuery(
    workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const catalog = useSuspenseQuery(
    authoringCatalogQueryOptions(apiClient, user.id),
  );
  const connections = useSuspenseQuery(
    editorConnectionsQueryOptions(apiClient, user.id, workspace.id),
  );
  return (
    <EditorProvider
      key={`${user.id}:${workspace.id}:${workflowId}`}
      initial={{
        graph: draft.data.draft.graph,
        etag: draft.data.etag,
        revision: draft.data.draft.revision,
        savedAt: draft.data.draft.updatedAt,
      }}
    >
      <ReactFlowProvider>
        <StepDiscussionsContext value={stepDiscussions ?? NO_DISCUSSIONS}>
          <WorkflowEditorSession
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            workflowId={workflowId}
            definitions={catalog.data.definitions.items}
            codeSettings={catalog.data.definitions.codeSettings}
            connections={connections.data?.items ?? NO_CONNECTIONS}
            connectionsAvailable={connections.data !== null}
            onRunAccepted={onRunAccepted}
            triggerNotice={triggerNotice}
            headerPresence={headerPresence}
            {...(renderEditingPresence === undefined
              ? {}
              : { renderEditingPresence })}
            {...(onPublished === undefined ? {} : { onPublished })}
          />
        </StepDiscussionsContext>
      </ReactFlowProvider>
    </EditorProvider>
  );
}
