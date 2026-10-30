import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';

import {
  apiQuery,
  application,
  origin,
  seedWebhook,
  sendWebhook,
  service,
} from './fixture.js';
import {
  browser,
  currentWebhookTrigger,
  deliver,
  listTriggers,
  publish,
  publishAndReconcile,
  runVersion,
  setStep,
  webhookStep,
  webhookThenSet,
} from './publish-flow.js';

export function registerSurvivesPublish(): void {
  // product-ux-01: publishing a changed version disables the live endpoint.
  it.fails(
    'keeps taking deliveries at the same address with the same secret after a publish, on the new version',
    async () => {
      const seeded = await seedWebhook('survives-input-change');
      expect((await deliver(seeded)).status).toBe(202);
      const v2 = await publishAndReconcile(seeded, webhookThenSet(1));
      const afterV2 = await deliver(seeded);
      expect(afterV2.status).toBe(202);
      expect(await runVersion(seeded.workspaceId, afterV2.json.runId)).toBe(v2);
      const v3 = await publishAndReconcile(seeded, webhookThenSet(2));
      const afterV3 = await deliver(seeded);
      expect(afterV3.status).toBe(202);
      expect(await runVersion(seeded.workspaceId, afterV3.json.runId)).toBe(v3);
    },
    60_000,
  );

  // product-ux-01: the trigger page says "No endpoint yet" after a publish.
  it.fails(
    'still reports one active, ready endpoint for the step after a publish',
    async () => {
      const seeded = await seedWebhook('survives-health');
      await publishAndReconcile(seeded, webhookThenSet(1));
      expect(await currentWebhookTrigger(seeded)).toMatchObject({
        kind: 'webhook',
        status: 'active',
        endpointReady: true,
      });
    },
    60_000,
  );

  // product-ux-01: delivery history is listed per version's trigger row, so it looks empty.
  it.fails(
    'keeps the delivery history of the endpoint across a publish',
    async () => {
      const seeded = await seedWebhook('survives-history');
      const before = await deliver(seeded);
      expect(before.status).toBe(202);
      await publishAndReconcile(seeded, webhookThenSet(1));
      const after = await deliver(seeded);
      expect(after.status).toBe(202);
      const trigger = await currentWebhookTrigger(seeded);
      const { session, triggersPath } = await browser(seeded);
      const history = await application.inject({
        method: 'GET',
        url: `${triggersPath}/${trigger.id}/webhook/deliveries`,
        headers: { cookie: session.cookieHeader },
      });
      expect(history.statusCode, history.body).toBe(200);
      expect(
        history
          .json<{ items: { outcome: string; runId: string | null }[] }>()
          .items.map(({ outcome, runId }) => [outcome, runId]),
      ).toEqual([
        ['accepted', after.json.runId],
        ['accepted', before.json.runId],
      ]);
    },
    60_000,
  );

  // product-ux-01: every delivery after the reconcile is refused with 401.
  it.fails(
    'refuses no delivery while a publish lands on a live endpoint',
    async () => {
      const seeded = await seedWebhook('survives-while-live');
      const statuses: number[] = [];
      const sending = { on: true };
      const sender = (async () => {
        while (sending.on) {
          statuses.push((await deliver(seeded)).status);
          // Stays under the endpoint's per-minute allowance across the publish.
          await delay(150);
        }
      })();
      await delay(300);
      const published = await publish(seeded, webhookThenSet(1));
      // Before the worker takes the job, the endpoint must already be answering.
      await delay(300);
      await published.reconcile();
      await delay(300);
      sending.on = false;
      await sender;
      expect(statuses.length).toBeGreaterThan(3);
      expect(new Set(statuses)).toEqual(new Set([202]));
    },
    60_000,
  );

  // product-ux-01: every authentication mode loses its credential on publish.
  it.fails.each([
    {
      name: 'secret URL',
      policy: { mode: 'secret_url', allowedOrigins: [] },
      credentialHeaders: (): Record<string, string> => ({}),
    },
    {
      name: 'header secret',
      policy: {
        mode: 'header_secret',
        headerName: 'authorization',
        allowedOrigins: [],
      },
      credentialHeaders: (secret: string | undefined) => ({
        authorization: `Bearer ${String(secret)}`,
      }),
    },
  ])(
    'keeps the $name mode and its credential after a publish',
    async ({ policy, credentialHeaders }) => {
      const seeded = await seedWebhook(`survives-${policy.mode}`);
      const { session, triggersPath } = await browser(seeded);
      const configured = await application.inject({
        method: 'POST',
        url: `${triggersPath}/${seeded.trigger.id}/webhook/authentication`,
        headers: {
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrf,
          'idempotency-key': randomUUID(),
        },
        payload: policy,
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const { endpointKey, signingSecret } = configured.json<{
        endpointKey: string;
        signingSecret?: string;
      }>();
      const send = () =>
        fetch(new URL(`/hooks/${endpointKey}`, origin), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            ...credentialHeaders(signingSecret),
          },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        });
      const before = await send();
      await before.arrayBuffer();
      expect(before.status).toBe(202);
      await publishAndReconcile(seeded, webhookThenSet(1));
      const after = await send();
      await after.arrayBuffer();
      expect(after.status).toBe(202);
      expect(await currentWebhookTrigger(seeded)).toMatchObject({
        status: 'active',
      });
    },
    60_000,
  );

  // product-ux-01: a rotation's overlap ends with the publish that kills the endpoint.
  it.fails(
    'keeps a rotated secret and the overlap of the previous one across a publish',
    async () => {
      const seeded = await seedWebhook('survives-rotation');
      const rotated = await service.rotateSecret({
        ...seeded,
        triggerId: seeded.trigger.id,
        idempotencyKey: randomUUID(),
        endpointKey: seeded.endpointKey,
      });
      const nextSecret = rotated.signingSecret;
      if (nextSecret === undefined) throw new Error('Rotated secret missing');
      await publishAndReconcile(seeded, webhookThenSet(1));
      expect((await deliver(seeded)).status).toBe(202);
      expect(
        (
          await sendWebhook(
            seeded.endpointKey,
            nextSecret,
            Buffer.from('{}'),
            randomUUID(),
          )
        ).status,
      ).toBe(202);
    },
    60_000,
  );

  // product-ux-01: both steps of a two-webhook workflow lose their endpoints.
  it.fails(
    'retires only the removed step when a workflow has two webhook steps',
    async () => {
      const seeded = await seedWebhook('survives-two-steps');
      const twoWebhooks = {
        settings: {},
        nodes: [
          webhookStep,
          { ...webhookStep, id: 'second', position: { x: 0, y: 200 } },
        ],
        edges: [],
      };
      await publishAndReconcile(seeded, twoWebhooks);
      const second = await currentWebhookTrigger(seeded, 'second');
      const provisioned = await service.provision({
        workspaceId: seeded.workspaceId,
        workflowId: seeded.workflowId,
        actorId: seeded.actorId,
        triggerId: second.id,
        idempotencyKey: randomUUID(),
      });
      const sendSecond = () =>
        sendWebhook(
          String(provisioned.endpointKey),
          String(provisioned.signingSecret),
          Buffer.from('{}'),
          randomUUID(),
        );
      expect((await deliver(seeded)).status).toBe(202);
      expect((await sendSecond()).status).toBe(202);

      await publishAndReconcile(seeded, {
        settings: {},
        nodes: [{ ...webhookStep, id: 'second', position: { x: 0, y: 200 } }],
        edges: [],
      });
      expect((await deliver(seeded)).status).toBe(401);
      expect((await sendSecond()).status).toBe(202);
    },
    60_000,
  );

  it('retires the endpoint when the publish removes its step', async () => {
    const seeded = await seedWebhook('retires-removed-step');
    expect((await deliver(seeded)).status).toBe(202);
    await publishAndReconcile(seeded, {
      settings: {},
      nodes: [
        {
          ...setStep(1),
          id: 'manual',
          definition: { key: 'core.manual', version: 1 },
          inputMappings: {},
        },
        setStep(1),
      ],
      edges: [
        {
          id: 'manual-apply',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'apply', port: 'in' },
        },
      ],
    });
    expect((await deliver(seeded)).status).toBe(401);
    const live = (await listTriggers(seeded)).filter(
      (item) => item.kind === 'webhook' && item.status !== 'disabled',
    );
    expect(live).toEqual([]);
  }, 60_000);

  // product-ux-01: the publish itself closes the endpoint, before the worker's job.
  it.fails(
    'keeps answering between the publish and the worker taking its job',
    async () => {
      const seeded = await seedWebhook('between-publish-and-reconcile');
      const before = await deliver(seeded);
      const v1 = await runVersion(seeded.workspaceId, before.json.runId);
      const { versionId: v2 } = await publish(seeded, webhookThenSet(1));
      const between = await deliver(seeded);
      expect(between.status).toBe(202);
      // Either version is a whole published workflow; both are honest here.
      expect([v1, v2]).toContain(
        await runVersion(seeded.workspaceId, between.json.runId),
      );
    },
    60_000,
  );
}

export function registerStoresKeysAsHashes(): void {
  it('stores the endpoint key only as a hash, before and after a publish', async () => {
    const seeded = await seedWebhook('key-stays-hashed');
    const stored = async () =>
      JSON.stringify(
        (
          await apiQuery(
            'select to_jsonb(endpoint) row from app.webhook_trigger_endpoints endpoint where workspace_id=$1',
            [seeded.workspaceId],
          )
        ).rows,
      );
    expect(await stored()).not.toContain(seeded.endpointKey);
    await publishAndReconcile(seeded, webhookThenSet(1));
    expect(await stored()).not.toContain(seeded.endpointKey);
  }, 60_000);
}
