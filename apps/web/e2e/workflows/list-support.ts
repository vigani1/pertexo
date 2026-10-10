import type { Page } from '@playwright/test';

/**
 * A workflow-list response for these summaries. The workflow list page asks
 * for the organized page (`include=organization`); other reads, such as
 * recent workflows, take the summaries as they are.
 */
export function workflowListBody(
  url: string,
  items: readonly unknown[],
  nextCursor: string | null = null,
) {
  if (new URL(url).searchParams.get('include') !== 'organization')
    return { items, nextCursor };
  return {
    items: items.map((workflow) => ({
      workflow,
      organization: {
        organizationRevision: 1,
        folderId: null,
        tags: [],
        isFavorite: false,
      },
    })),
    nextCursor,
  };
}

/** The workflow list's folder and tag reads: none filed or tagged. */
export async function routeEmptyWorkflowOrganization(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-folders`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflow-tags?**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}
