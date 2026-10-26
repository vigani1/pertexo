import { parseCollaborationSearch } from '@/features/workflow-collaboration/search.public';
import { createRoute } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';
import { workflowIdentifierSchema } from '@pertexo/contracts';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import {
  failureNotificationPolicyQueryOptions,
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from '@/features/workflow-settings/queries.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import {
  filtersFromSearch,
  sanitizeWorkflowRunSearch,
  stepHealthQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { WorkflowHubPending } from '../../root/status/workflow-pending';
import { pageTitle } from '../../root/page-title';
import {
  authoringPrefetches,
  probeResource,
  settlePrefetches,
  warmPrefetches,
} from '../../root/route-context';
import { workspaceScopeRoute } from '../../workspace/routes';

/**
 * `/workflows/$workflowId` is an immersive hub (no spine): a floating command
 * bar with Build, Runs, Triggers, Versions and Settings tabs. An invalid ID
 * leaves `workflowId` null and the hub renders "doesn't exist".
 */
export const workflowHubRoute = createRoute({
  getParentRoute: () => workspaceScopeRoute,
  path: 'workflows/$workflowId',
  pendingComponent: WorkflowHubPending,
  beforeLoad: ({ params }) => {
    const parsed = workflowIdentifierSchema.safeParse(params.workflowId);
    return { workflowId: parsed.success ? parsed.data : null };
  },
  // The summary decides whether the workflow exists; a missing one renders
  // inside the workspace shell instead of the hub.
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return { found: false };
    return probeResource(
      context,
      queryClient.query(
        workflowSummaryQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    );
  },
  component: lazyRoute(() => import('./index'), 'WorkflowHubRoute'),
});

export const workflowBuildRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: '/',
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return { found: false };
    const draftRead = queryClient.query(
      workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
    );
    const supportingReads = authoringPrefetches(context, user.id, workspace.id);
    const [draft] = await Promise.all([
      probeResource(context, draftRead),
      settlePrefetches(context, supportingReads),
    ]);
    return draft;
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Build', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../build'), 'WorkflowBuildRoute'),
});

export const workflowRunsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: 'runs',
  validateSearch: (search) => sanitizeWorkflowRunSearch(search),
  loaderDeps: ({ search }) => filtersFromSearch(search),
  loader: ({ context, deps }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null || !workspace.capabilities.includes('run:read'))
      return;
    warmPrefetches(context, [
      queryClient.infiniteQuery(
        workflowRunsInfiniteQueryOptions(apiClient, user.id, workspace.id, {
          ...deps,
          workflowId,
        }),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Workflow runs', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../runs'), 'WorkflowRunsRoute'),
});

export const workflowTriggersRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: 'triggers',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    warmPrefetches(context, [
      // Webhook details are only for people who can edit the workflow.
      ...(workspace.capabilities.includes('workflow:update')
        ? [
            queryClient.query(
              webhookTriggersQueryOptions(
                apiClient,
                user.id,
                workspace.id,
                workflowId,
              ),
            ),
          ]
        : []),
      queryClient.query(
        scheduleTriggersQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
      queryClient.query(
        workflowVersionsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Triggers', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../triggers'), 'WorkflowTriggersRoute'),
});

export const workflowVersionsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: 'versions',
  loader: ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    warmPrefetches(context, [
      queryClient.query(
        workflowVersionsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Versions', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../versions'), 'WorkflowVersionsRoute'),
});

export const workflowSettingsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  pendingComponent: WorkflowHubPending,
  path: 'settings',
  // Every section's read settles first, so the page renders whole rather
  // than growing and shrinking as each one arrives.
  loader: async ({ context }) => {
    const { apiClient, queryClient, user, workspace, workflowId } = context;
    if (workflowId === null) return;
    const can = (capability: (typeof workspace.capabilities)[number]) =>
      workspace.capabilities.includes(capability);
    await settlePrefetches(context, [
      queryClient.query(
        workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
      ),
      queryClient.query(
        workflowVersionsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
          workflowId,
        ),
      ),
      ...(can('workflow:update')
        ? [
            queryClient.query(
              failureNotificationDestinationsQueryOptions(
                apiClient,
                user.id,
                workspace.id,
              ),
            ),
            queryClient.query(
              failureNotificationPolicyQueryOptions(
                apiClient,
                user.id,
                workspace.id,
                workflowId,
              ),
            ),
          ]
        : []),
      ...(can('run:read')
        ? [
            queryClient.query(
              stepHealthQueryOptions(
                apiClient,
                user.id,
                workspace.id,
                workflowId,
              ),
            ),
          ]
        : []),
    ]);
  },
  head: ({ match }) => ({
    meta: [
      { title: pageTitle('Workflow settings', match.context.workspace.name) },
    ],
  }),
  component: lazyRoute(() => import('../settings'), 'WorkflowSettingsRoute'),
});

export const workflowCommentsRoute = createRoute({
  getParentRoute: () => workflowHubRoute,
  path: 'comments',
  validateSearch: (search) => parseCollaborationSearch(search),
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Comments', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../comments'), 'WorkflowCommentsRoute'),
});
