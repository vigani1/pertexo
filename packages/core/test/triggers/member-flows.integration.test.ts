import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkflowFolderDatabase } from '../../src/authoring/organization/folders/commands.repository.js';
import { ScheduleTriggerError } from '../../src/triggers/schedules/errors.js';
import {
  WebhookIngressRateLimitExceededError,
  WebhookTriggerNotFoundError,
} from '../../src/triggers/webhooks/errors.js';
import { createWebhookTestEventStore } from '../../src/triggers/webhooks/test-events/store.js';
import { WorkflowNotFoundError } from '../../src/authoring/workflows/errors.js';
import { adminUrl, url } from './webhooks/context.js';
import {
  actorId,
  afterAllFixture2,
  apiConfig,
  apiQuery,
  beforeAllFixture1,
  createWebhookScenario,
  deliverReconciliation,
  hash,
  ownerQuery,
  publishNextTriggerWorkflowVersion,
  publishTriggerWorkflow,
  schedules,
  secret,
  webhook,
  workflowTriggerIds,
  workspaceId,
} from './webhooks/fixture.js';
import { sqlStates } from './webhooks/ingress/lock-holder.js';

type Scenario = Awaited<ReturnType<typeof createWebhookScenario>>;
type Role = 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';

const ROLES: readonly Role[] = [
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
];
const EDITORS: readonly Role[] = ['owner', 'admin', 'builder'];
const NOT_EDITORS: readonly Role[] = ['operator', 'viewer'];

const members = new Map<Role, string>();
let listeners: ReturnType<typeof createWebhookTestEventStore>;
let folders: ReturnType<typeof createWorkflowFolderDatabase>;
/** Secret rows and receipts have no plain reader but the superuser. */
let inspector: Pool;

async function addMember(role: string, status = 'active') {
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

const member = (role: Role) => {
  const id = members.get(role);
  if (id === undefined) throw new Error(`No ${role} in this workspace`);
  return id;
};

const scope = ({ verification }: Scenario, actor: string) => ({
  workspaceId,
  actorId: actor,
  workflowId: verification.workflowId,
});

const receipt = () => ({
  idempotencyKey: randomUUID(),
  requestHash: hash(randomUUID()),
});

/** Everything a trigger command could have written. */
async function writes({ verification, resources }: Scenario) {
  const { rows } = await inspector.query(
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
const COMMANDS = [
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

const editorReads = [
  [
    'webhook health',
    async (s: Scenario, actor: string) =>
      (await webhook.getHealth(scope(s, actor))).map(({ id }) => id),
    (s: Scenario) => expect.arrayContaining([s.resources.webhookId]),
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

const scheduleReads = [
  [
    'schedules',
    async (s: Scenario, actor: string) =>
      (await schedules.list(scope(s, actor))).map(({ id }) => id),
    (s: Scenario) => expect.arrayContaining([s.resources.scheduleId]),
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
            misfirePolicy: 'skip',
          },
        })
      ).items.length,
    () => 2,
  ],
] as const;

const READS = [...editorReads, ...scheduleReads];

const readNotFound = (name: string) =>
  name === 'webhook health' || name === 'webhook deliveries'
    ? WebhookTriggerNotFoundError
    : ScheduleTriggerError;

function setWorkspaceStatus(status: 'suspended' | 'pending_deletion') {
  return ownerQuery(
    status === 'suspended'
      ? "update app.workspaces set status='suspended' where id=$1"
      : `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
           deletion_requested_by=$2,deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
    status === 'suspended' ? [workspaceId] : [workspaceId, actorId],
  );
}

const reopenWorkspace = () =>
  ownerQuery(
    `update app.workspaces set status='active',deletion_requested_at=null,
       deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
    [workspaceId],
  );

describe('who changes a trigger', () => {
  const allowed = COMMANDS.flatMap((command) =>
    EDITORS.map((role) => ({ ...command, role })),
  );
  const refused = COMMANDS.flatMap((command) =>
    NOT_EDITORS.map((role) => ({ ...command, role })),
  );

  it.each(allowed)('$role can $name', async ({ run, role }) => {
    const scenario = await createWebhookScenario();
    const before = await writes(scenario);
    await expect(run(scenario, member(role))).resolves.toMatchObject({
      replayed: false,
    });
    expect(await writes(scenario)).not.toEqual(before);
  });

  it.each(refused)(
    '$role cannot $name: not found, nothing written',
    async ({ run, refused: error, role }) => {
      const scenario = await createWebhookScenario();
      const before = await writes(scenario);
      await expect(run(scenario, member(role))).rejects.toBeInstanceOf(error);
      expect(await writes(scenario)).toEqual(before);
    },
  );

  it.each(ROLES.map((role) => ({ role })))(
    'lets only an editor provision, as $role',
    async ({ role }) => {
      const published = await publishTriggerWorkflow();
      await deliverReconciliation(
        published.created.workflowId,
        published.published.version.id,
        {
          eventId: published.eventId,
          payloadChecksum: published.eventChecksum,
        },
      );
      const { webhookId } = await workflowTriggerIds(
        published.created.workflowId,
      );
      const attempt = webhook.provision({
        workspaceId,
        actorId: member(role),
        workflowId: published.created.workflowId,
        triggerId: webhookId,
        endpointId: randomUUID(),
        endpointKeyHash: hash(randomUUID()),
        secret: secret(),
        ...receipt(),
      });
      const { rows: before } = await apiQuery<{ count: number }>(
        'select count(*)::int count from app.webhook_trigger_endpoints where workflow_id=$1',
        [published.created.workflowId],
      );
      if (EDITORS.includes(role)) {
        await expect(attempt).resolves.toMatchObject({
          trigger: { status: 'active', endpointReady: true },
        });
        return;
      }
      await expect(attempt).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
      expect(before).toEqual([{ count: 0 }]);
    },
  );

  it.each(COMMANDS)(
    'refuses to $name for a trigger of another workflow, or none at all',
    async ({ run, refused: error }) => {
      const scenario = await createWebhookScenario();
      const other = await createWebhookScenario();
      const before = await writes(scenario);
      const othersBefore = await writes(other);
      await expect(
        run(scenario, actorId, other.resources.webhookId),
      ).rejects.toBeInstanceOf(error);
      await expect(
        run(scenario, actorId, other.resources.scheduleId),
      ).rejects.toBeInstanceOf(error);
      await expect(run(scenario, actorId, randomUUID())).rejects.toBeInstanceOf(
        error,
      );
      expect(await writes(scenario)).toEqual(before);
      expect(await writes(other)).toEqual(othersBefore);
    },
  );

  it.each([
    ['a suspended membership', "status='suspended'"],
    ['a removed membership', "status='removed'"],
  ])('refuses %s everywhere', async (_name, change) => {
    const scenario = await createWebhookScenario();
    const actor = await addMember('admin');
    await ownerQuery(
      `update app.workspace_memberships set ${change} where workspace_id=$1 and user_id=$2`,
      [workspaceId, actor],
    );
    const before = await writes(scenario);
    for (const { run, refused: error } of COMMANDS)
      await expect(run(scenario, actor)).rejects.toBeInstanceOf(error);
    for (const [name, read] of READS)
      await expect(read(scenario, actor)).rejects.toBeInstanceOf(
        readNotFound(name),
      );
    expect(await writes(scenario)).toEqual(before);
  });

  it('refuses a deactivated user everywhere', async () => {
    const scenario = await createWebhookScenario();
    const actor = await addMember('admin');
    await ownerQuery("update app.users set status='suspended' where id=$1", [
      actor,
    ]);
    const before = await writes(scenario);
    for (const { run, refused: error } of COMMANDS)
      await expect(run(scenario, actor)).rejects.toBeInstanceOf(error);
    for (const [name, read] of READS)
      await expect(read(scenario, actor)).rejects.toBeInstanceOf(
        readNotFound(name),
      );
    expect(await writes(scenario)).toEqual(before);
  });
});

describe('an exact retry of a trigger command', () => {
  it('returns its receipt, and a different request under the same key conflicts', async () => {
    const scenario = await createWebhookScenario();
    const endpointKeyHash = hash(randomUUID());
    const command = {
      ...scope(scenario, actorId),
      triggerId: scenario.resources.webhookId,
      endpointKeyHash,
      ...receipt(),
    };
    await expect(webhook.rotateEndpoint(command)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(webhook.rotateEndpoint(command)).resolves.toMatchObject({
      replayed: true,
    });
    const before = await writes(scenario);
    await expect(
      webhook.rotateEndpoint({ ...command, requestHash: hash(randomUUID()) }),
    ).rejects.toThrow();
    expect(await writes(scenario)).toEqual(before);

    const schedule = {
      ...scope(scenario, actorId),
      triggerId: scenario.resources.scheduleId,
      enabled: false,
      ...receipt(),
    };
    await expect(schedules.setEnabled(schedule)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(schedules.setEnabled(schedule)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      schedules.setEnabled({ ...schedule, requestHash: hash(randomUUID()) }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/conflict/u) as unknown,
    });
  });
});

describe('reads on a trigger', () => {
  const editorCases = READS.flatMap(([name, read, expected]) =>
    EDITORS.map((role) => ({ name, read, expected, role })),
  );
  it.each(editorCases)(
    '$role reads $name',
    async ({ read, expected, role }) => {
      const scenario = await createWebhookScenario();
      expect(await read(scenario, member(role))).toEqual(expected(scenario));
    },
  );

  const outsiders = NOT_EDITORS.flatMap((role) => [
    ...editorReads.map(([name, read]) => ({ name, read, role, sees: false })),
    ...scheduleReads.map(([name, read, expected]) => ({
      name,
      read,
      expected,
      role,
      sees: true,
    })),
  ]);
  it.each(outsiders)('$role on $name: sees it is $sees', async (item) => {
    const scenario = await createWebhookScenario();
    const attempt = item.read(scenario, member(item.role));
    if (item.sees && 'expected' in item)
      expect(await attempt).toEqual(item.expected(scenario));
    else await expect(attempt).rejects.toBeInstanceOf(readNotFound(item.name));
  });
});

describe('a workspace that is not active', () => {
  it.each(READS.map(([name, read, expected]) => ({ name, read, expected })))(
    'still answers $name while suspended, and nothing once deletion is pending',
    async ({ name, read, expected }) => {
      const scenario = await createWebhookScenario();
      try {
        await setWorkspaceStatus('suspended');
        expect(await read(scenario, actorId)).toEqual(expected(scenario));
        await reopenWorkspace();
        await setWorkspaceStatus('pending_deletion');
        await expect(read(scenario, actorId)).rejects.toBeInstanceOf(
          readNotFound(name),
        );
      } finally {
        await reopenWorkspace();
      }
    },
  );

  it.each(COMMANDS)(
    'refuses to $name while suspended or pending deletion, and writes nothing',
    async ({ run, refused: error }) => {
      const scenario = await createWebhookScenario();
      const before = await writes(scenario);
      try {
        for (const status of ['suspended', 'pending_deletion'] as const) {
          await setWorkspaceStatus(status);
          await expect(run(scenario, actorId)).rejects.toBeInstanceOf(error);
          await reopenWorkspace();
          expect(await writes(scenario)).toEqual(before);
        }
      } finally {
        await reopenWorkspace();
      }
    },
  );
});

describe('a restricted folder', () => {
  async function inRestrictedFolder(scenario: Scenario) {
    const folder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: `Private ${randomUUID()}`,
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder.id;
    await folders.placeWorkflow({
      workspaceId,
      actorId,
      workflowId: scenario.verification.workflowId,
      folderId: folder,
      expectedOrganizationRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await ownerQuery(
      "update app.workflow_folders set access_mode='restricted' where workspace_id=$1 and id=$2",
      [workspaceId, folder],
    );
    return folder;
  }

  it('hides everything from a builder without a grant', async () => {
    const scenario = await createWebhookScenario();
    await inRestrictedFolder(scenario);
    const builder = member('builder');
    const before = await writes(scenario);
    for (const { run, refused } of COMMANDS)
      await expect(run(scenario, builder)).rejects.toBeInstanceOf(refused);
    for (const [name, read] of READS)
      await expect(read(scenario, builder)).rejects.toBeInstanceOf(
        readNotFound(name),
      );
    expect(await writes(scenario)).toEqual(before);
  });

  it('lets a builder with a viewer grant read trigger health but not change a trigger', async () => {
    const scenario = await createWebhookScenario();
    const folder = await inRestrictedFolder(scenario);
    const builder = member('builder');
    await ownerQuery(
      "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
      [randomUUID(), workspaceId, folder, builder],
    );
    const before = await writes(scenario);
    for (const [, read, expected] of READS)
      expect(await read(scenario, builder)).toEqual(expected(scenario));
    for (const { run, refused } of COMMANDS)
      await expect(run(scenario, builder)).rejects.toBeInstanceOf(refused);
    expect(await writes(scenario)).toEqual(before);
  });
});

describe('a test listener', () => {
  async function draftRevision({ verification }: Scenario) {
    const { rows } = await ownerQuery<{ revision: number }>(
      'select revision from app.workflow_drafts where workflow_id=$1',
      [verification.workflowId],
    );
    const revision = rows[0]?.revision;
    if (revision === undefined) throw new Error('Draft is missing');
    return revision;
  }

  const start = async (scenario: Scenario, actor: string) => {
    const id = randomUUID();
    const endpointKeyHash = hash(randomUUID());
    const snapshot = await listeners.start({
      id,
      workspaceId,
      actorId: actor,
      workflowId: scenario.verification.workflowId,
      nodeId: scenario.verification.nodeId,
      endpointKeyHash,
      expectedDraftRevision: await draftRevision(scenario),
      authentication: { mode: 'signed', allowedOrigins: [] },
      secret: secret(),
    });
    return { id, endpointKeyHash, snapshot };
  };
  const listenerScope = (scenario: Scenario, actor: string, id: string) => ({
    id,
    workspaceId,
    actorId: actor,
    workflowId: scenario.verification.workflowId,
    nodeId: scenario.verification.nodeId,
  });

  it.each(NOT_EDITORS.map((role) => ({ role })))(
    'refuses start, read and stop by $role and changes nothing',
    async ({ role }) => {
      const scenario = await createWebhookScenario();
      const { id } = await start(scenario, actorId);
      const before = await writes(scenario);
      const actor = member(role);
      await expect(start(scenario, actor)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await expect(
        listeners.get(listenerScope(scenario, actor, id)),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      await expect(
        listeners.stop(listenerScope(scenario, actor, id)),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect(await writes(scenario)).toEqual(before);
      await expect(
        listeners.get(listenerScope(scenario, actorId, id)),
      ).resolves.toMatchObject({ state: 'waiting' });
    },
  );

  it('stops answering a sender once its creator loses access', async () => {
    const scenario = await createWebhookScenario();
    const creator = await addMember('builder');
    const { endpointKeyHash } = await start(scenario, creator);
    const reference = await listeners.resolve(endpointKeyHash);
    if (reference === null) throw new Error('Expected a live listener');
    await ownerQuery(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [workspaceId, creator],
    );
    await expect(listeners.resolve(endpointKeyHash)).resolves.toBeNull();
    await expect(listeners.capture(reference, { body: {} })).resolves.toBe(
      false,
    );
  });

  it('has no listener to find once it expires, and limits a sender’s attempts', async () => {
    const scenario = await createWebhookScenario();
    const { endpointKeyHash } = await start(scenario, actorId);
    const reference = await listeners.resolve(endpointKeyHash);
    if (reference === null) throw new Error('Expected a live listener');
    let refusal: unknown;
    for (let attempt = 0; attempt < 200 && refusal === undefined; attempt += 1)
      await listeners.consume(reference).catch((error: unknown) => {
        refusal = error;
      });
    expect(refusal).toBeInstanceOf(WebhookIngressRateLimitExceededError);

    await inspector.query(
      `update app.webhook_test_events
          set created_at=clock_timestamp()-interval '1 hour',
              expires_at=clock_timestamp()-interval '1 second'
        where workspace_id=$1 and endpoint_key_hash=$2`,
      [workspaceId, endpointKeyHash],
    );
    await expect(listeners.resolve(endpointKeyHash)).resolves.toBeNull();
  });
});

describe('trigger changes racing each other', () => {
  it('never deadlocks with a publish or with one another', async () => {
    const scenario = await createWebhookScenario();
    for (let round = 0; round < 5; round += 1) {
      const outcomes = await Promise.allSettled([
        COMMANDS[1].run(scenario, actorId),
        COMMANDS[3].run(scenario, actorId),
        publishNextTriggerWorkflowVersion(scenario.verification.workflowId),
        COMMANDS[1].run(scenario, actorId),
      ]);
      const states = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? sqlStates(outcome.reason) : [],
      );
      expect(states).not.toContain('40P01');
    }
  }, 60_000);
});
