import { setTimeout as delay } from 'node:timers/promises';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../lifecycle.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

const step = (
  id: string,
  key: string,
  x: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  definition: { key, version: 1 },
  position: { x, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  ...extra,
});

const fetchOrders = (timeoutMillis: number) =>
  step('fetch', 'http.request', 200, {
    label: 'Fetch orders',
    config: {
      method: 'GET',
      url: 'https://api.example.test/orders?page=1',
      headers: {},
      timeoutMillis,
      maxRedirects: 0,
      maxResponseBytes: 4_096,
      inlineResponseBytes: 4_096,
    },
  });

function afterManual(candidate: ReturnType<typeof step>) {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [step('manual', 'core.manual', 0), candidate],
    edges: [
      {
        id: 'manual-candidate',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: candidate.id, port: 'in' },
      },
    ],
  };
}

const insideForEach = (inner: ReturnType<typeof step>) =>
  afterManual(
    step('loop', 'core.foreach', 200, {
      label: 'Each order',
      inputMappings: { items: { kind: 'literal', value: [1, 2] } },
      structured: {
        kind: 'for_each',
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          settings: {},
          nodes: [inner],
          edges: [],
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    }),
  );

type Report = Readonly<{
  valid: boolean;
  issues: readonly Readonly<Record<string, unknown>>[];
}>;

/** The issue names the step's own field, which is what the editor opens on. */
const refusedAt = (path: string) => [
  {
    path,
    message: expect.stringContaining('120000') as string,
  },
];
const FETCH_TIMEOUT = '$.nodes.fetch.config.timeoutMillis';

describeIntegration('settings a run could only refuse', () => {
  let fixture: WorkflowLifecycleApiFixture;

  beforeAll(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  }, 120_000);

  afterAll(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  async function newWorkflow() {
    const owner = await fixture.login('owner');
    const made = await fixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${fixture.workspaceId}/workflows`,
      headers: mutationHeaders(owner),
      payload: { name: `Settings ${randomUUID()}` },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ workflow: { id: string } }>().workflow.id;
    const base = `/v1/workspaces/${fixture.workspaceId}/workflows/${id}`;

    const save = async (graph: unknown) => {
      const current = await fixture.application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: owner.cookieHeader },
      });
      const saved = await fixture.application.inject({
        method: 'PUT',
        url: `${base}/draft`,
        headers: mutationHeaders(owner, {
          'if-match': String(current.headers.etag),
        }),
        payload: { graph },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      return String(saved.headers.etag);
    };
    const validate = async () => {
      const send = () =>
        fixture.application.inject({
          method: 'POST',
          url: `${base}/validate`,
          headers: mutationHeaders(owner),
          payload: {},
        });
      let checked = await send();
      // A busy machine's validator asks for a retry, which is what the page offers.
      for (let tries = 1; checked.statusCode === 503 && tries < 5; tries += 1) {
        await delay(1_000);
        checked = await send();
      }
      expect(checked.statusCode, checked.body).toBe(200);
      return checked.json<Report>();
    };
    const publish = (tag: string) =>
      fixture.application.inject({
        method: 'POST',
        url: `${base}/publish`,
        headers: mutationHeaders(owner, { 'if-match': tag }),
        payload: {},
      });
    const startRun = () =>
      fixture.application.inject({
        method: 'POST',
        url: `${base}/runs`,
        headers: mutationHeaders(owner),
        payload: { input: {} },
      });
    const versions = async () => {
      const listed = await fixture.application.inject({
        method: 'GET',
        url: `${base}/versions`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(listed.statusCode, listed.body).toBe(200);
      return listed.json<{ items: readonly { id: string }[] }>().items;
    };
    const runCount = () =>
      fixture.withOwner(async (client) => {
        const { rows } = await client.query<{ count: number }>(
          'select count(*)::int as count from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
          [fixture.workspaceId, id],
        );
        return rows[0]?.count;
      });
    return { save, validate, publish, startRun, versions, runCount };
  }

  it('a timeout past its limit is refused at validate and publish, and nothing is written', async () => {
    const workflow = await newWorkflow();
    const tag = await workflow.save(afterManual(fetchOrders(300_000)));

    const report = await workflow.validate();
    expect(report.valid).toBe(false);
    expect(report.issues).toMatchObject(refusedAt(FETCH_TIMEOUT));

    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(422);
    expect(published.json<{ errors: unknown }>().errors).toMatchObject(
      refusedAt(FETCH_TIMEOUT),
    );
    await expect(workflow.versions()).resolves.toEqual([]);

    const started = await workflow.startRun();
    expect(started.statusCode, started.body).toBeGreaterThanOrEqual(400);
    await expect(workflow.runCount()).resolves.toBe(0);
  }, 60_000);

  it('a timeout within its limit publishes', async () => {
    const workflow = await newWorkflow();
    const tag = await workflow.save(afterManual(fetchOrders(5_000)));
    await expect(workflow.validate()).resolves.toMatchObject({
      valid: true,
      issues: [],
    });
    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(200);
    await expect(workflow.versions()).resolves.toHaveLength(1);
  }, 60_000);

  it('a config relying on a default publishes', async () => {
    const workflow = await newWorkflow();
    // Read file's convertValues has a default, which a run fills in.
    const tag = await workflow.save(
      afterManual(
        step('read', 'core.read_file', 200, {
          config: { format: 'csv', delimiter: ',' },
          inputMappings: { file: { kind: 'run_input', path: '$.file' } },
        }),
      ),
    );
    await expect(workflow.validate()).resolves.toMatchObject({
      valid: true,
      issues: [],
    });
    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(200);
    await expect(workflow.versions()).resolves.toHaveLength(1);
  }, 60_000);

  it('a step inside a For each is refused too', async () => {
    const workflow = await newWorkflow();
    const tag = await workflow.save(insideForEach(fetchOrders(300_000)));
    const report = await workflow.validate();
    expect(report.valid).toBe(false);
    expect(report.issues).toMatchObject(
      refusedAt(
        '$.nodes.loop.structured.body.nodes.fetch.config.timeoutMillis',
      ),
    );
    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(422);
    await expect(workflow.versions()).resolves.toEqual([]);
  }, 60_000);

  it('a disabled step never runs, so its settings stop nothing', async () => {
    const workflow = await newWorkflow();
    const tag = await workflow.save(
      afterManual(
        step('fetch', 'http.request', 200, {
          ...fetchOrders(300_000),
          disabled: true,
        }),
      ),
    );
    await expect(workflow.validate()).resolves.toMatchObject({
      valid: true,
      issues: [],
    });
    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(200);
    await expect(workflow.versions()).resolves.toHaveLength(1);
  }, 60_000);

  it('nor does a step inside a disabled For each', async () => {
    const workflow = await newWorkflow();
    const graph = insideForEach(fetchOrders(300_000));
    const tag = await workflow.save({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'loop' ? { ...node, disabled: true } : node,
      ),
    });
    await expect(workflow.validate()).resolves.toMatchObject({
      valid: true,
      issues: [],
    });
    const published = await workflow.publish(tag);
    expect(published.statusCode, published.body).toBe(200);
  }, 60_000);

  it('republishing an old draft says so, and leaves the published version running', async () => {
    const workflow = await newWorkflow();
    const good = await workflow.publish(
      await workflow.save(afterManual(fetchOrders(5_000))),
    );
    expect(good.statusCode, good.body).toBe(200);
    const live = good.json<{ version: { id: string } }>().version.id;

    const refused = await workflow.publish(
      await workflow.save(afterManual(fetchOrders(300_000))),
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ errors: unknown }>().errors).toMatchObject(
      refusedAt(FETCH_TIMEOUT),
    );
    await expect(workflow.versions()).resolves.toMatchObject([{ id: live }]);

    const started = await workflow.startRun();
    expect(started.statusCode, started.body).toBeLessThan(300);
    expect(started.json<{ run: { workflowVersionId: string } }>().run).toEqual(
      expect.objectContaining({ workflowVersionId: live }),
    );
  }, 60_000);
});
