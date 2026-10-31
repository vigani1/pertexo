import { expect } from 'vitest';

import type { Reply } from '../../support/better-auth/real-api.support.js';
import type { World } from './world.js';

type Refusal = Readonly<{ status: number; code: string }>;

export type Read = Readonly<{
  name: string;
  /** The least role that holds the capability; the page opens for it. */
  as: 'owner' | 'viewer';
  path: (world: World) => string;
  /** A read that takes its query in a body, as the data table rows do. */
  query?: object;
  shows: (body: never, world: World) => void;
  refusal?: Refusal;
}>;

export const HIDDEN: Refusal = { status: 404, code: 'resource.not_found' };
const FORBIDDEN: Refusal = { status: 403, code: 'auth.forbidden' };

type Items = Readonly<{ items: readonly Readonly<{ id: string }>[] }>;

const lists =
  (select: (world: World) => string) => (body: Items, world: World) => {
    expect(body.items.map(({ id }) => id)).toContain(select(world));
  };
const answers = (body: unknown) => {
  expect(body).toBeTypeOf('object');
};
const root = ({ workspaceId }: World) => `/v1/workspaces/${workspaceId}`;
const workflow = (world: World) =>
  `${root(world)}/workflows/${world.workflowId}`;

/** Open on purpose until the purge starts: `UNPURGED_WORKSPACE_STATUSES`. */
export const READS_OPEN_UNTIL_PURGE: readonly Read[] = [
  {
    name: 'the variables',
    as: 'viewer',
    path: (world) => `${root(world)}/variables`,
    shows: answers,
  },
  {
    name: "a variable's references",
    as: 'viewer',
    path: (world) => `${root(world)}/variables/usage?name=RATE`,
    shows: (body: { totalWorkflows: number }) => {
      expect(body.totalWorkflows).toBeGreaterThan(0);
    },
  },
];

/** The reads a suspended workspace already answers. */
export const READS_OPEN_TODAY: readonly Read[] = [
  ...READS_OPEN_UNTIL_PURGE,
  {
    name: 'the run list',
    as: 'viewer',
    path: (world) => `${root(world)}/runs`,
    shows: lists(({ runId }) => runId),
  },
  {
    name: 'a run',
    as: 'viewer',
    path: (world) => `${root(world)}/runs/${world.runId}`,
    shows: (body: { run: { id: string } }, world) => {
      expect(body.run.id).toBe(world.runId);
    },
  },
  {
    name: 'the run statistics',
    as: 'viewer',
    path: (world) => `${root(world)}/run-statistics`,
    shows: answers,
  },
  {
    name: 'the usage trends',
    as: 'viewer',
    path: (world) => `${root(world)}/usage-trends?period=90d`,
    shows: (body: { total: number }) => {
      expect(body.total).toBeGreaterThan(0);
    },
  },
  {
    name: 'the data tables',
    as: 'viewer',
    path: (world) => `${root(world)}/data-tables`,
    shows: (body: { tables: readonly { id: string }[] }, world) => {
      expect(body.tables.map(({ id }) => id)).toContain(world.tableId);
    },
  },
  {
    name: "a data table's rows",
    as: 'viewer',
    path: (world) => `${root(world)}/data-tables/${world.tableId}/rows/query`,
    query: { filters: [], limit: 10, offset: 0 },
    shows: answers,
  },
  {
    name: 'the audit log',
    as: 'owner',
    path: (world) => `${root(world)}/governance/audit`,
    shows: answers,
  },
  {
    name: 'the governance settings',
    as: 'owner',
    path: (world) => `${root(world)}/governance/settings`,
    shows: answers,
  },
];

/** The reads a suspended workspace refuses today, which ADR 013/027 opens. */
export const READS_CLOSED_TODAY: readonly Read[] = [
  {
    name: 'the workflow list',
    as: 'viewer',
    path: (world) => `${root(world)}/workflows`,
    shows: lists(({ workflowId }) => workflowId),
  },
  {
    name: 'the workflow folders',
    as: 'viewer',
    path: (world) => `${root(world)}/workflow-folders`,
    shows: answers,
  },
  {
    name: 'the workflow tags',
    as: 'viewer',
    path: (world) => `${root(world)}/workflow-tags`,
    shows: answers,
  },
  {
    name: 'a workflow',
    as: 'viewer',
    path: workflow,
    shows: (body: { workflow: { id: string } }, world) => {
      expect(body.workflow.id).toBe(world.workflowId);
    },
  },
  {
    name: "a workflow's draft",
    as: 'viewer',
    path: (world) => `${workflow(world)}/draft`,
    shows: answers,
  },
  {
    name: "a workflow's versions",
    as: 'viewer',
    path: (world) => `${workflow(world)}/versions`,
    shows: lists(({ versionId }) => versionId),
  },
  {
    name: 'the connections',
    as: 'viewer',
    path: (world) => `${root(world)}/connections`,
    shows: lists(({ connectionId }) => connectionId),
  },
  {
    name: 'a connection',
    as: 'viewer',
    path: (world) => `${root(world)}/connections/${world.connectionId}`,
    shows: (body: { id: string }, world) => {
      expect(body.id).toBe(world.connectionId);
    },
  },
  {
    name: 'the members',
    as: 'owner',
    path: (world) => `${root(world)}/members`,
    shows: (body: { items: readonly unknown[] }) => {
      expect(body.items).toHaveLength(2);
    },
    refusal: FORBIDDEN,
  },
  {
    name: 'the invitations',
    as: 'owner',
    path: (world) => `${root(world)}/invitations`,
    shows: answers,
    refusal: FORBIDDEN,
  },
  {
    name: 'the usage capacity',
    as: 'viewer',
    path: (world) => `${root(world)}/usage-capacity`,
    shows: answers,
  },
  {
    name: 'the inbox',
    as: 'viewer',
    path: (world) => `${root(world)}/notifications`,
    shows: answers,
  },
  {
    name: 'the inbox summary',
    as: 'viewer',
    path: (world) => `${root(world)}/notifications/summary`,
    shows: answers,
  },
  {
    name: 'the inbox preferences',
    as: 'viewer',
    path: (world) => `${root(world)}/notifications/preferences`,
    shows: answers,
  },
  {
    name: 'the requests and approvals',
    as: 'owner',
    path: (world) => `${root(world)}/pending-tasks?view=all&status=all`,
    shows: lists(({ taskId }) => taskId),
  },
  {
    name: 'a request or approval',
    as: 'viewer',
    path: (world) => `${root(world)}/pending-tasks/${world.taskId}`,
    shows: (body: { task: { id: string } }, world) => {
      expect(body.task.id).toBe(world.taskId);
    },
  },
  {
    name: "a workflow's comments",
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments`,
    shows: answers,
  },
  {
    name: 'a comment thread',
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments/${world.threadId}`,
    shows: answers,
  },
  {
    name: 'who a comment can mention',
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments/people`,
    shows: answers,
  },
  {
    name: 'who else is on a workflow',
    as: 'viewer',
    path: (world) =>
      `${workflow(world)}/presence?tabId=00000000-0000-4000-8000-000000000001`,
    shows: answers,
  },
  {
    name: "a workflow's input cases",
    as: 'viewer',
    path: (world) => `${workflow(world)}/input-cases`,
    shows: answers,
  },
  {
    name: "a draft's pinned samples",
    as: 'viewer',
    path: (world) => `${workflow(world)}/draft/samples`,
    shows: answers,
  },
  {
    name: "a workflow's concurrency",
    as: 'viewer',
    path: (world) => `${workflow(world)}/concurrency`,
    shows: answers,
  },
  {
    name: "a workflow's error workflow",
    as: 'viewer',
    path: (world) => `${workflow(world)}/error-workflow`,
    shows: answers,
  },
  {
    name: "a workflow's auto-pause",
    as: 'viewer',
    path: (world) => `${workflow(world)}/auto-pause`,
    shows: answers,
  },
  {
    name: "a workflow's alert policy",
    as: 'owner',
    path: (world) => `${workflow(world)}/failure-notification-policy`,
    shows: answers,
  },
  {
    name: "a workflow's publication review",
    as: 'viewer',
    path: (world) => `${workflow(world)}/publication-review`,
    shows: answers,
  },
  {
    name: 'a draft check',
    as: 'viewer',
    path: (world) => `${workflow(world)}/validate`,
    query: {},
    shows: answers,
  },
  {
    name: 'a form',
    as: 'viewer',
    path: (world) => `${root(world)}/workflows/${world.formWorkflowId}/form`,
    shows: answers,
  },
  {
    name: "a form's access",
    as: 'owner',
    path: (world) =>
      `${root(world)}/workflows/${world.formWorkflowId}/form/access`,
    shows: answers,
  },
  {
    name: "a form's events",
    as: 'owner',
    path: (world) =>
      `${root(world)}/workflows/${world.formWorkflowId}/form/events`,
    shows: answers,
  },
  {
    name: "a tag's workflows",
    as: 'owner',
    path: (world) => `${root(world)}/workflow-tags/${world.tagId}/workflows`,
    shows: answers,
  },
  {
    name: 'who a folder can be shared with',
    as: 'owner',
    path: (world) => `${root(world)}/resource-sharing-principals?kind=member`,
    shows: answers,
  },
  {
    name: "a folder's sharing",
    as: 'owner',
    path: (world) =>
      `${root(world)}/workflow-folders/${world.folderId}/sharing`,
    shows: answers,
  },
  {
    name: "a connection's usage",
    as: 'viewer',
    path: (world) => `${root(world)}/connections/${world.connectionId}/usage`,
    shows: answers,
  },
  {
    name: 'the workspace auto-pause',
    as: 'viewer',
    path: (world) => `${root(world)}/auto-pause`,
    shows: answers,
  },
  {
    name: 'the alert destinations',
    as: 'owner',
    path: (world) => `${root(world)}/failure-notification-destinations`,
    shows: answers,
  },
  {
    name: 'the promotion settings',
    as: 'owner',
    path: (world) => `${root(world)}/promotions/settings`,
    shows: answers,
  },
  {
    name: 'the promotion candidates',
    as: 'owner',
    path: (world) => `${root(world)}/promotions/candidates`,
    shows: answers,
  },
  {
    name: 'the promotion history',
    as: 'owner',
    path: (world) => `${root(world)}/promotions/history`,
    shows: answers,
  },
  {
    name: 'the single sign-on settings',
    as: 'owner',
    path: (world) => `${root(world)}/sso`,
    shows: answers,
    refusal: FORBIDDEN,
  },
  {
    name: 'the API tokens',
    as: 'owner',
    path: (world) => `${root(world)}/api-tokens`,
    shows: answers,
    refusal: FORBIDDEN,
  },
];

export function expectShown(read: Read, reply: Reply, world: World): void {
  expect(reply.statusCode, reply.payload).toBe(200);
  read.shows(reply.json<never>(), world);
}
