import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';

// A per-browser convenience: open the workspace someone used last. Storage can
// be missing or blocked, so every access is guarded and failure is harmless.
const STORAGE_KEY = 'pertexo:last-workspace:v1';

export function rememberLastWorkspace(userId: string, workspaceId: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, workspaceId }));
  } catch {
    // Storage unavailable: the picker remains the fallback.
  }
}

/** The workspace this person opened last in this browser, if remembered. */
export function readLastWorkspace(userId: string): string | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Reflect.get(parsed, 'userId') === userId
    ) {
      const workspaceId: unknown = Reflect.get(parsed, 'workspaceId');
      return typeof workspaceId === 'string' ? workspaceId : undefined;
    }
  } catch {
    // Unreadable storage behaves like a first visit.
  }
  return undefined;
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
