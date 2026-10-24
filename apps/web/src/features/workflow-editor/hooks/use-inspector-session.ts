import { useMemo } from 'react';
import { useEditorSession } from '../model/state/context';

export function useInspectorSession() {
  const { scope, catalog } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const enabled =
    catalog.connectionsAvailable &&
    workspace.capabilities.includes('connection:use');
  const workspaceScope = useMemo(
    () => ({ apiClient, userId, workspaceId: workspace.id }),
    [apiClient, userId, workspace.id],
  );
  const callScope = useMemo(
    () => ({ ...workspaceScope, workflowId }),
    [workspaceScope, workflowId],
  );
  const channelLookup = useMemo(
    () => ({ ...workspaceScope, enabled }),
    [workspaceScope, enabled],
  );
  return { ...catalog, workspaceScope, callScope, channelLookup };
}
