import { workflowSummarySchema } from '@pertexo/contracts';
import type { Page } from '@playwright/test';

/** Match the API's opt-in projections, including the organized page envelope. */
export function workflowListBody(
  url: string,
  items: readonly unknown[],
  nextCursor: string | null = null,
) {
  const include = new URL(url).searchParams.get('include')?.split(',') ?? [];
  const workflows = items.map((item) => workflowSummaryBody(url, item));
  return {
    items: include.includes('organization')
      ? workflows.map((workflow) => ({
          workflow,
          organization: {
            organizationRevision: 1,
            folderId: null,
            tags: [],
            isFavorite: false,
          },
        }))
      : workflows,
    nextCursor,
  };
}

/** Custom organization scenarios use the same projection policy as ordinary pages. */
export function workflowSummaryBody(url: string, item: unknown) {
  const { listSummary, ...workflow } = workflowSummarySchema.parse(item);
  return new URL(url).searchParams
    .get('include')
    ?.split(',')
    .includes('listSummary') === true
    ? {
        ...workflow,
        // Identity-only fixtures describe an empty workflow with no run history.
        listSummary: listSummary ?? {
          shape: { nodes: [], edges: [] },
          recentRuns: [],
        },
      }
    : workflow;
}

/** The workflow list's folder and tag reads: none filed or tagged. */
export async function routeEmptyWorkflowOrganization(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-folders/review-move`,
    (route) => {
      const body = route.request().postDataJSON() as {
        kind: string;
        folderId?: string;
        workflowIds?: string[];
      };
      const ids =
        body.kind === 'folder' ? [body.folderId] : (body.workflowIds ?? []);
      return route.fulfill({
        json: {
          items: ids.map((id) => ({
            id,
            requiresReview: false,
            token: 'a'.repeat(64),
            removedRestrictions: [],
          })),
        },
      });
    },
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-folders`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-tags?**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}
