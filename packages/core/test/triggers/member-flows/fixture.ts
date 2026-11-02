import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

import { createWorkflowFolderDatabase } from '../../../src/authoring/organization/folders/commands.repository.js';
import { ScheduleTriggerError } from '../../../src/triggers/schedules/errors.js';
import { WebhookTriggerNotFoundError } from '../../../src/triggers/webhooks/errors.js';
import { createWebhookTestEventStore } from '../../../src/triggers/webhooks/test-events/store.js';
import { adminUrl, url } from '../webhooks/context.js';
import type { createWebhookScenario } from '../webhooks/fixture.js';
import {
  actorId,
  afterAllFixture2,
  apiConfig,
  beforeAllFixture1,
  hash,
  ownerQuery,
  schedules,
  secret,
  webhook,
  workspaceId,
} from '../webhooks/fixture.js';

export type Scenario = Awaited<ReturnType<typeof createWebhookScenario>>;
export type Role = 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';

export const ROLES: readonly Role[] = [
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
];
export const EDITORS: readonly Role[] = ['owner', 'admin', 'builder'];
export const NOT_EDITORS: readonly Role[] = ['operator', 'viewer'];

const members = new Map<Role, string>();
export let listeners: ReturnType<typeof createWebhookTestEventStore>;
export let folders: ReturnType<typeof createWorkflowFolderDatabase>;
/** Secret rows and receipts have no plain reader but the superuser. */
export let inspector: Pool;

export async function addMember(role: string, status = 'active') {
  const id = randomUUID();
  await ownerQuery(
    `insert into app.users(id,email,display_name) values($1,$2,'Trigger member')`,
    [id, `${id}@example.test`],
  );
  await ownerQuery(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,$4)`,
    [workspaceId, id, role, status],
  );
  return id;
}

/** The workspace, its five members and the stores, for one test file. */
export function useMemberFlows() {
  beforeAll(async () => {
    await beforeAllFixture1();
    inspector = new Pool({ connectionString: url(adminUrl), max: 1 });
    listeners = createWebhookTestEventStore(apiConfig);
    folders = createWorkflowFolderDatabase(apiConfig);
    members.set('owner', actorId);
    for (const role of ROLES.slice(1)) members.set(role, await addMember(role));
  }, 60_000);

  afterAll(async () => {
    await inspector.end();
    await listeners.close();
    await folders.close();
    await afterAllFixture2();
  });
}

export const member = (role: Role) => {
  const id = members.get(role);
  if (id === undefined) throw new Error(`No ${role} in this workspace`);
  return id;
};

export const scope = ({ verification }: Scenario, actor: string) => ({
  workspaceId,
  actorId: actor,
  workflowId: verification.workflowId,
});

export const receipt = () => ({
  idempotencyKey: randomUUID(),
  requestHash: hash(randomUUID()),
});

/** Everything a trigger command could have written. */
export async function writes({ verification, resources }: Scenario) {
  const { rows } = await inspector.query<Record<string, unknown>>(
    `select endpoint.endpoint_key_hash,endpoint.current_secret_version_id,endpoint.authentication,
            endpoint.updated_at,schedule.status schedule_status,
            (select count(*)::int from app.webhook_trigger_secret_versions secret
              where secret.workflow_id=endpoint.workflow_id) secrets,
            (select count(*)::int from app.idempotency_records record
              where record.workspace_id=endpoint.workspace_id) receipts,
            (select count(*)::int from app.webhook_test_events listener
              where listener.workspace_id=endpoint.workspace_id) listeners
       from app.webhook_trigger_endpoints endpoint
       join app.trigger_schedules schedule on schedule.trigger_id=$2
      where endpoint.id=$1`,
    [verification.endpointId, resources.scheduleId],
  );
  return rows;
}

/** The four webhook commands and the schedule switch, each aimed at a trigger. */
export const COMMANDS = [
  {
    name: 'configure authentication',
    refused: WebhookTriggerNotFoundError,
    run: (s: Scenario, actor: string, triggerId = s.resources.webhookId) =>
      webhook.configureAuthentication({
        ...scope(s, actor),
        triggerId,
        authentication: { mode: 'signed', allowedOrigins: [] },
        endpointKeyHash: hash(randomUUID()),
        secret: secret(),
        ...receipt(),
      }),
  },
  {
    name: 'rotate the endpoint',
    refused: WebhookTriggerNotFoundError,
    run: (s: Scenario, actor: string, triggerId = s.resources.webhookId) =>
      webhook.rotateEndpoint({
        ...scope(s, actor),
        triggerId,
        endpointKeyHash: hash(randomUUID()),
        ...receipt(),
      }),
  },
  {
    name: 'rotate the secret',
    refused: WebhookTriggerNotFoundError,
    run: (s: Scenario, actor: string, triggerId = s.resources.webhookId) =>
      webhook.rotateSecret({
        ...scope(s, actor),
        triggerId,
        endpointKeyHash: s.verification.endpointKeyHash,
        secret: secret(),
        ...receipt(),
      }),
  },
  {
    name: 'turn a schedule off',
    refused: ScheduleTriggerError,
    run: (s: Scenario, actor: string, triggerId = s.resources.scheduleId) =>
      schedules.setEnabled({
        ...scope(s, actor),
        triggerId,
        enabled: false,
        ...receipt(),
      }),
  },
] as const;

export const editorReads = [
  [
    'webhook health',
    async (s: Scenario, actor: string) =>
      (await webhook.getHealth(scope(s, actor))).map(({ id }) => id),
    (s: Scenario) => expect.arrayContaining([s.resources.webhookId]) as unknown,
  ],
  [
    'webhook deliveries',
    async (s: Scenario, actor: string) =>
      (
        await webhook.listDeliveries({
          ...scope(s, actor),
          triggerId: s.resources.webhookId,
        })
      ).items,
    () => [],
  ],
] as const;

export const scheduleReads = [
  [
    'schedules',
    async (s: Scenario, actor: string) =>
      (await schedules.list(scope(s, actor))).map(({ id }) => id),
    (s: Scenario) =>
      expect.arrayContaining([s.resources.scheduleId]) as unknown,
  ],
  [
    'occurrences',
    async (s: Scenario, actor: string) =>
      (
        await schedules.listOccurrences({
          ...scope(s, actor),
          triggerId: s.resources.scheduleId,
        })
      ).items,
    () => [],
  ],
  [
    'next fire times',
    async (s: Scenario, actor: string) =>
      (
        await schedules.nextFireTimes({
          ...scope(s, actor),
          triggerId: s.resources.scheduleId,
          count: 2,
        })
      ).items.length,
    () => 2,
  ],
  [
    'previewed fire times',
    async (s: Scenario, actor: string) =>
      (
        await schedules.previewFireTimes({
          ...scope(s, actor),
          count: 2,
          recurrence: {
            kind: 'interval',
            intervalMinutes: 15,
          },
        })
      ).items.length,
    () => 2,
  ],
] as const;

export const READS = [...editorReads, ...scheduleReads];

export const readNotFound = (name: string) =>
  name === 'webhook health' || name === 'webhook deliveries'
    ? WebhookTriggerNotFoundError
    : ScheduleTriggerError;

export function setWorkspaceStatus(status: 'suspended' | 'pending_deletion') {
  return ownerQuery(
    status === 'suspended'
      ? "update app.workspaces set status='suspended' where id=$1"
      : `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
           deletion_requested_by=$2,deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
    status === 'suspended' ? [workspaceId] : [workspaceId, actorId],
  );
}

export const reopenWorkspace = () =>
  ownerQuery(
    `update app.workspaces set status='active',deletion_requested_at=null,
       deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
    [workspaceId],
  );
