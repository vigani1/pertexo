import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  listTriggers,
  ownWorkspace,
  provisionWebhook,
  publishCurrentDraft,
  publishDraft,
  publishGraph,
  readRun,
  runReaches,
  signedDelivery,
  signUp,
  step,
  type StackOwner,
} from '../support/real-stack/owner.js';
import { createRealStack } from '../support/real-stack/stack.js';

const webhook = step('webhook', 'core.webhook', 0, {
  responseMode: 'workflow',
  responseWaitSeconds: 30,
});

function link(from: string, to: string) {
  return {
    id: `${from}-${to}`,
    source: { nodeId: from, port: 'out' },
    target: { nodeId: to, port: 'in' },
  };
}

const respond = (answer: string) => ({
  ...step('respond', 'core.respond_webhook', 400, { bodyType: 'json' }),
  inputMappings: {
    body: { kind: 'literal', value: { answer } },
  },
});

/** A webhook whose caller is told which published graph answered it. */
const answers = (answer: string) => ({
  nodes: [webhook, respond(answer)],
  edges: [link('webhook', 'respond')],
});

const answersAfterSleeping = (answer: string, durationSeconds: number) => ({
  nodes: [
    webhook,
    step('wait', 'core.wait', 200, { durationSeconds }),
    respond(answer),
  ],
  edges: [link('webhook', 'wait'), link('wait', 'respond')],
});

const noWebhook = {
  nodes: [
    step('manual', 'core.manual', 0),
    step('stop', 'core.terminate', 200),
  ],
  edges: [link('manual', 'stop')],
};

describe.skipIf(!betterAuthIntegrationEnabled)(
  'a webhook address on real API and worker processes',
  () => {
    const stack = createRealStack('webhook-endpoints');
    let origin = '';
    let stop: () => Promise<unknown> = () => Promise.resolve();
    let send: Awaited<ReturnType<typeof signUp>> | undefined;

    beforeAll(async () => {
      await stack.create();
      const running = await stack.boot();
      origin = running.origin;
      stop = running.stop;
    }, 180_000);
    afterAll(async () => {
      await stop();
      await stack.close();
    }, 60_000);

    async function newOwner() {
      send ??= await signUp(stack, origin);
      return ownWorkspace(send);
    }

    /** Publishes a graph with a webhook step and creates its address. */
    async function live(owner: StackOwner, graph: typeof noWebhook) {
      const published = await publishGraph(owner, 'Webhook', graph);
      const credentials = await provisionWebhook(owner, published.path);
      return { ...published, ...credentials };
    }

    async function deliver(
      target: Readonly<{ endpointKey: string; signingSecret: string }>,
      secret = target.signingSecret,
    ) {
      const response = await signedDelivery(origin, target.endpointKey, secret);
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
    }

    /** The worker has taken the latest publish or restore: the step's one trigger is ready again. */
    async function triggerIsReady(owner: StackOwner, path: string) {
      let id: string | undefined;
      await expect
        .poll(
          async () => {
            const live = (await listTriggers(owner, path)).filter(
              ({ kind, status }) => kind === 'webhook' && status !== 'disabled',
            );
            id = live[0]?.id;
            return live.map(({ status, endpointReady }) => [
              status,
              endpointReady,
            ]);
          },
          { timeout: 30_000, interval: 250 },
        )
        .toEqual([['active', true]]);
      return String(id);
    }

    async function acceptedDeliveries(
      owner: StackOwner,
      path: string,
      triggerId: string,
    ) {
      const history = await owner.send(
        'GET',
        `${path}/triggers/${triggerId}/webhook/deliveries`,
      );
      expect(history.status).toBe(200);
      const { items } = (await history.json()) as {
        items: { outcome: string }[];
      };
      return items.filter(({ outcome }) => outcome === 'accepted').length;
    }

    /** Puts a retained version's graph into the draft and publishes it, as the versions page does. */
    async function restoreAndPublish(
      owner: StackOwner,
      path: string,
      versionId: string,
    ) {
      const etag = await restoreVersion(owner, path, versionId);
      return publishCurrentDraft(owner, path, etag);
    }

    async function restoreVersion(
      owner: StackOwner,
      path: string,
      versionId: string,
    ) {
      const draft = await owner.send('GET', `${path}/draft`);
      const restored = await owner.send(
        'POST',
        `${path}/versions/${versionId}/restore`,
        {},
        { 'if-match': String(draft.headers.get('etag')) },
      );
      expect(restored.status, await restored.text()).toBe(200);
      return String(restored.headers.get('etag'));
    }

    async function runsOf(owner: StackOwner, workflowId: string) {
      const read = await owner.send(
        'GET',
        `${owner.base}/runs?workflowId=${workflowId}&limit=20`,
      );
      expect(read.status).toBe(200);
      return ((await read.json()) as { items: { id: string }[] }).items;
    }

    it('lets a caller waiting on a run keep its answer from the version it started on, across a publish', async () => {
      const owner = await newOwner();
      const target = await live(owner, answersAfterSleeping('from v1', 8));
      let answered = false;
      const waitingCaller = deliver(target).finally(() => {
        answered = true;
      });

      let runId: string | undefined;
      await expect
        .poll(
          async () => {
            runId = (await runsOf(owner, target.workflowId))[0]?.id;
            return runId !== undefined;
          },
          { timeout: 5_000, interval: 100 },
        )
        .toBe(true);
      const underway = String(runId);
      await runReaches(owner, underway, 'waiting');

      const v2 = await publishDraft(owner, target.path, answers('from v2'));
      expect(v2).not.toBe(target.versionId);
      expect(answered).toBe(false);
      expect((await readRun(owner, underway)).status).toBe('waiting');

      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v2' },
      });
      expect(answered).toBe(false);

      expect(await waitingCaller).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
      await runReaches(owner, underway, 'succeeded');
      expect((await readRun(owner, underway)).workflowVersionId).toBe(
        target.versionId,
      );
    }, 120_000);

    it('still answers a waiting caller when a publish turns workflow responses off', async () => {
      const owner = await newOwner();
      const target = await live(owner, answersAfterSleeping('from v1', 8));
      const waitingCaller = deliver(target);
      await expect
        .poll(
          async () =>
            (await runsOf(owner, target.workflowId))[0]?.id !== undefined,
          { timeout: 5_000, interval: 100 },
        )
        .toBe(true);

      await publishDraft(owner, target.path, {
        nodes: [step('webhook', 'core.webhook', 0)],
        edges: [],
      });
      const next = await deliver(target);
      expect(next.status).toBe(202);
      expect(next.body).toMatchObject({ replayed: false });

      expect(await waitingCaller).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
    }, 120_000);

    it('pauses the address while archived and brings it back unchanged on restore', async () => {
      const owner = await newOwner();
      const target = await live(owner, answers('kept'));
      expect((await deliver(target)).status).toBe(200);

      const lifecycle = async (command: 'archive' | 'restore') => {
        const read = await owner.send('GET', target.path);
        const { workflow } = (await read.json()) as {
          workflow: { lifecycleRevision: number };
        };
        const changed = await owner.send('POST', `${target.path}/${command}`, {
          expectedLifecycleRevision: workflow.lifecycleRevision,
        });
        expect(changed.status, await changed.text()).toBe(202);
      };

      await lifecycle('archive');
      const runsBefore = (await runsOf(owner, target.workflowId)).length;
      expect((await deliver(target)).status).toBe(401);
      expect(await runsOf(owner, target.workflowId)).toHaveLength(runsBefore);

      await lifecycle('restore');
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'kept' },
      });
      const triggerId = await triggerIsReady(owner, target.path);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'kept' },
      });
      expect(await acceptedDeliveries(owner, target.path, triggerId)).toBe(3);
    }, 120_000);

    it('keeps the address when an older version is restored, moving to it only when that is published', async () => {
      const owner = await newOwner();
      const target = await live(owner, answers('from v1'));
      await publishDraft(owner, target.path, answers('from v2'));
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v2' },
      });

      // Restoring only replaces the draft; the published version keeps answering.
      const etag = await restoreVersion(owner, target.path, target.versionId);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v2' },
      });

      await publishCurrentDraft(owner, target.path, etag);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
      const triggerId = await triggerIsReady(owner, target.path);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
      expect(await acceptedDeliveries(owner, target.path, triggerId)).toBe(4);
    }, 120_000);

    it('stops answering when a publish removes the step, and restoring it brings back the same address and secret', async () => {
      const owner = await newOwner();
      const target = await live(owner, answers('from v1'));
      expect((await deliver(target)).status).toBe(200);

      await publishDraft(owner, target.path, noWebhook);
      expect((await deliver(target)).status).toBe(401);
      await expect
        .poll(
          async () =>
            (await listTriggers(owner, target.path)).filter(
              ({ kind, status }) => kind === 'webhook' && status !== 'disabled',
            ),
          { timeout: 30_000, interval: 250 },
        )
        .toEqual([]);
      expect((await deliver(target)).status).toBe(401);

      await restoreAndPublish(owner, target.path, target.versionId);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
      const triggerId = await triggerIsReady(owner, target.path);
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v1' },
      });
      expect(await acceptedDeliveries(owner, target.path, triggerId)).toBe(3);
    }, 120_000);

    it('takes the same secret on a later version with that step, and rotates it there with the old one overlapping', async () => {
      const owner = await newOwner();
      const target = await live(owner, answers('from v1'));
      await publishDraft(owner, target.path, noWebhook);
      await publishDraft(owner, target.path, answers('from v3'));
      expect(await deliver(target)).toEqual({
        status: 200,
        body: { answer: 'from v3' },
      });
      const triggerId = await triggerIsReady(owner, target.path);

      const rotated = await owner.send(
        'POST',
        `${target.path}/triggers/${triggerId}/webhook/rotate-secret`,
        { endpointKey: target.endpointKey },
      );
      const body = await rotated.text();
      expect(rotated.status, body).toBe(200);
      const { signingSecret } = JSON.parse(body) as { signingSecret: string };
      expect(signingSecret).not.toBe(target.signingSecret);

      expect((await deliver(target, signingSecret)).status).toBe(200);
      expect((await deliver(target)).status).toBe(200);
      expect((await deliver(target, 'not-the-secret')).status).toBe(401);
    }, 120_000);
  },
);
