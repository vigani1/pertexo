import type { ApiTokenScope } from '@pertexo/contracts';
import type { World } from './fixture.js';

type Case = Readonly<{
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: (w: World) => string;
  scopes: readonly ApiTokenScope[];
  body?:
    | Readonly<Record<string, unknown>>
    | ((w: World) => Readonly<Record<string, unknown>>);
  status: number;
}>;
const workflow = (w: World) => `${w.base}/workflows/${w.workflowId}`;
const table = (w: World) => `${w.base}/data-tables/${w.tableId}`;
export const routes: readonly Case[] = [
  {
    name: 'archive',
    method: 'POST',
    path: (w) => `${workflow(w)}/archive`,
    scopes: ['workflow:publish'],
    body: { expectedLifecycleRevision: 1 },
    status: 202,
  },
  {
    name: 'restore',
    method: 'POST',
    path: (w) => `${workflow(w)}/restore`,
    scopes: ['workflow:publish'],
    body: { expectedLifecycleRevision: 2 },
    status: 202,
  },
  {
    name: 'pause settings',
    method: 'GET',
    path: (w) => `${workflow(w)}/auto-pause`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'replace pause',
    method: 'PUT',
    path: (w) => `${workflow(w)}/auto-pause`,
    scopes: ['workflow:update'],
    body: { enabled: true, thresholdOverride: 7, expectedSettingsRevision: 1 },
    status: 200,
  },
  {
    name: 'resume',
    method: 'POST',
    path: (w) => `${workflow(w)}/resume`,
    scopes: ['workflow:publish'],
    body: { expectedPauseRevision: '1' },
    status: 200,
  },
  {
    name: 'webhooks',
    method: 'GET',
    path: (w) => w.webhook.base,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'provision webhook',
    method: 'POST',
    path: (w) => `${w.webhook.endpoint}/provision`,
    scopes: ['workflow:update'],
    body: {},
    status: 200,
  },
  {
    name: 'deliveries',
    method: 'GET',
    path: (w) => `${w.webhook.endpoint}/deliveries`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'schedules',
    method: 'GET',
    path: (w) => `${w.schedule.base}/schedules`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'disable schedule',
    method: 'POST',
    path: (w) => `${w.schedule.endpoint}/disable`,
    scopes: ['workflow:update'],
    body: {},
    status: 200,
  },
  {
    name: 'enable schedule',
    method: 'POST',
    path: (w) => `${w.schedule.endpoint}/enable`,
    scopes: ['workflow:update'],
    body: {},
    status: 200,
  },
  {
    name: 'occurrences',
    method: 'GET',
    path: (w) => `${w.schedule.endpoint}/occurrences`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'next runs',
    method: 'GET',
    path: (w) => `${w.schedule.endpoint}/next-runs`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'schedule preview',
    method: 'POST',
    path: (w) => `${w.schedule.base}/schedules/preview`,
    scopes: ['workflow:read'],
    body: {
      config: { kind: 'interval', intervalMinutes: 5, misfirePolicy: 'skip' },
    },
    status: 200,
  },
  {
    name: 'tables',
    method: 'GET',
    path: (w) => `${w.base}/data-tables`,
    scopes: ['workspace:read'],
    status: 200,
  },
  {
    name: 'create table',
    method: 'POST',
    path: (w) => `${w.base}/data-tables`,
    scopes: ['workflow:update'],
    body: {
      name: 'Narrow scope table',
      columns: [{ name: 'value', type: 'text' }],
    },
    status: 201,
  },
  {
    name: 'edit schema',
    method: 'PUT',
    path: (w) => `${table(w)}/schema`,
    scopes: ['workflow:update'],
    body: {
      expectedRevision: 1,
      change: {
        operation: 'add_column',
        column: { name: 'note', type: 'text' },
      },
    },
    status: 200,
  },
  {
    name: 'query rows',
    method: 'POST',
    path: (w) => `${table(w)}/rows/query`,
    scopes: ['workspace:read'],
    body: { filters: [], limit: 10, offset: 0 },
    status: 200,
  },
  {
    name: 'write rows',
    method: 'POST',
    path: (w) => `${table(w)}/rows`,
    scopes: ['workflow:update'],
    body: {
      command: {
        operation: 'insert',
        table: 'Qualified rows',
        values: { value: 'written' },
      },
    },
    status: 200,
  },
  {
    name: 'import rows',
    method: 'POST',
    path: (w) => `${table(w)}/import`,
    scopes: ['workflow:update'],
    body: { csv: 'value\nimported\n' },
    status: 200,
  },
  {
    name: 'variables',
    method: 'GET',
    path: (w) => `${w.base}/variables`,
    scopes: ['workspace:read'],
    status: 200,
  },
  {
    name: 'replace variables',
    method: 'PUT',
    path: (w) => `${w.base}/variables`,
    scopes: ['variable:manage'],
    body: (w) => ({
      expectedRevision: w.variableRevision,
      values: { REGION: 'eu' },
    }),
    status: 200,
  },
  {
    name: 'variable references',
    method: 'GET',
    path: (w) => `${w.base}/variables/usage?name=REGION`,
    scopes: ['workspace:read', 'workflow:read'],
    status: 200,
  },
  {
    name: 'tags',
    method: 'GET',
    path: (w) => `${w.base}/workflow-tags`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'assign tags',
    method: 'POST',
    path: (w) => `${workflow(w)}/tags`,
    scopes: ['workflow:update'],
    body: { expectedOrganizationRevision: 1, tagIds: [] },
    status: 200,
  },
  {
    name: 'tag assignments',
    method: 'GET',
    path: (w) => `${w.base}/workflow-tags/${w.tagId}/workflows`,
    scopes: ['workflow:read'],
    status: 200,
  },
  {
    name: 'remove table',
    method: 'DELETE',
    path: table,
    scopes: ['workflow:update'],
    body: { expectedRevision: 2 },
    status: 200,
  },
];
