import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WebhookTriggerNotFoundError } from '../../../src/triggers/webhooks/errors.js';
import { sqlStates } from '../webhooks/ingress/lock-holder.js';
import {
  actorId,
  apiQuery,
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
} from '../webhooks/fixture.js';
import {
  addMember,
  COMMANDS,
  EDITORS,
  member,
  NOT_EDITORS,
  READS,
  readNotFound,
  receipt,
  ROLES,
  scope,
  useMemberFlows,
  writes,
} from './fixture.js';

useMemberFlows();

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
