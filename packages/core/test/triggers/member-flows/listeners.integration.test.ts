import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import { WebhookIngressRateLimitExceededError } from '../../../src/triggers/webhooks/errors.js';
import {
  actorId,
  createWebhookScenario,
  hash,
  ownerQuery,
  secret,
  workspaceId,
} from '../webhooks/fixture.js';
import {
  addMember,
  inspector,
  listeners,
  member,
  NOT_EDITORS,
  useMemberFlows,
  writes,
  type Scenario,
} from './fixture.js';

useMemberFlows();

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
