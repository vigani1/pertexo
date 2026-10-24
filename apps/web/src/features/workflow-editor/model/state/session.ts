import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  AccessibleWorkspace,
  ConnectionResponse,
  NodeDefinitionCatalogItem,
  WorkflowSummary,
} from '@pertexo/contracts';
import type { WorkflowIssuesView } from '@/features/workflow-publish/public';
import type { ApiClient } from '@/lib/api/client';
import type { useCanvasEffects } from '../../hooks/use-canvas-effects';
import type { useEditorActions } from '../../hooks/use-editor-actions';

/** Live session references; Query owns these snapshots and the store owns the draft. */
export type EditorSession = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
  }>;
  catalog: Readonly<{
    definitions: readonly NodeDefinitionCatalogItem[];
    codeSettings: CodeSettings | undefined;
    connections: readonly ConnectionResponse[];
    connectionsAvailable: boolean;
  }>;
  editing: Readonly<{
    workflow: WorkflowSummary | undefined;
    verifyIdentity: () => Promise<void>;
    canUpdate: boolean;
    paused: boolean;
    issues: WorkflowIssuesView;
    checking: boolean;
    actions: ReturnType<typeof useEditorActions>;
    ensureSaved: () => Promise<Readonly<{ revision: number }>>;
    flushSave: () => Promise<void>;
    effects: ReturnType<typeof useCanvasEffects>;
  }>;
}>;
