import type { AccessibleWorkspace } from '@pertexo/contracts';
import { pageTitle } from '../root/page-title';
import { warmPrefetches, type RouterContext } from '../root/route-context';

type WorkspacePageContext = RouterContext &
  Readonly<{ workspace: AccessibleWorkspace }>;

/** The breadcrumb and document title always name the same workspace page. */
export function workspacePage(name: string) {
  return {
    staticData: { crumb: name },
    head: ({
      match,
    }: Readonly<{
      match: Readonly<{
        context: Readonly<{ workspace: Readonly<{ name: string }> }>;
      }>;
    }>) => ({
      meta: [{ title: pageTitle(name, match.context.workspace.name) }],
    }),
  };
}

/** Gate optional warming before loading its factories or starting any reads. */
export async function warmWorkspacePage(
  context: WorkspacePageContext,
  capability: AccessibleWorkspace['capabilities'][number],
  reads: () => Promise<readonly Promise<unknown>[]>,
): Promise<void> {
  if (!context.workspace.capabilities.includes(capability)) return;
  warmPrefetches(context, await reads());
}
