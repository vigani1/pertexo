import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { QueryClient } from '@tanstack/react-query';

// A per-browser convenience: open the workspace someone used last. Storage can
// be missing or blocked, so every access is guarded and failure is harmless.
const STORAGE_KEY = 'pertexo:last-workspace:v1';

export function rememberLastWorkspace(
  userId: string,
  workspace: Pick<AccessibleWorkspace, 'id' | 'name'>,
) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        userId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      }),
    );
  } catch {
    // Storage unavailable: the picker remains the fallback.
  }
}

function readRemembered(): Record<string, unknown> | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // Unreadable storage behaves like a first visit.
    return undefined;
  }
}

/**
 * The name to show while a workspace opens, before the session is confirmed:
 * from workspaces already loaded in this tab, else the one opened last in
 * this browser. Undefined when neither knows it.
 */
export function knownWorkspaceName(
  queryClient: QueryClient,
  workspaceId: string,
): string | undefined {
  const cached = queryClient
    .getQueriesData<readonly AccessibleWorkspace[]>({
      predicate: (query) => query.queryKey[2] === 'accessible-workspaces',
    })
    .flatMap(([, workspaces]) => workspaces ?? [])
    .find((workspace) => workspace.id === workspaceId);
  if (cached !== undefined) return cached.name;
  const remembered = readRemembered();
  const name = remembered?.workspaceName;
  return remembered?.workspaceId === workspaceId && typeof name === 'string'
    ? name
    : undefined;
}

/** The workspace this person opened last in this browser, if remembered. */
export function readLastWorkspace(userId: string): string | undefined {
  const remembered = readRemembered();
  if (remembered?.userId !== userId) return undefined;
  const workspaceId = remembered.workspaceId;
  return typeof workspaceId === 'string' ? workspaceId : undefined;
}

function isOpenable(workspace: AccessibleWorkspace): boolean {
  return (
    workspace.status === 'active' ||
    (workspace.status === 'pending_deletion' &&
      workspace.capabilities.includes('workspace:manage'))
  );
}

/**
 * Where "/" should land: the last-used workspace when it's still openable,
 * the only workspace when there is exactly one, otherwise the picker.
 */
export function landingWorkspace(
  userId: string,
  workspaces: readonly AccessibleWorkspace[],
): AccessibleWorkspace | undefined {
  const lastId = readLastWorkspace(userId);
  const last = workspaces.find((workspace) => workspace.id === lastId);
  if (last !== undefined && isOpenable(last)) return last;
  const openable = workspaces.filter(isOpenable);
  return openable.length === 1 ? openable[0] : undefined;
}
