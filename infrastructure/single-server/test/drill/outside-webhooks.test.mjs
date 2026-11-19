import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { waitFor } from './support/process.mjs';
import {
  createWorkspace,
  publishWebhookWorkflow,
  readRun,
  waitForSucceededRun,
} from './support/product.mjs';
import {
  INTERNET,
  closeInternet,
  openInternet,
} from './support/public-internet.mjs';
import {
  createOwner,
  createPublicServer,
  publicClient,
  receivedSpans,
  sql,
} from './support/public-server.mjs';
import { destroyServer, joinPrivateNetwork } from './support/server.mjs';
import { createReport } from './support/simulation-report.mjs';

// Webhooks the way real senders deliver them: from another network, through
// the public name and certificate, sometimes large, sometimes slow, sometimes
// twice. The operator's telemetry collector shows whether the run kept the
// sender's trace and who sent it. Rerun on a Linux machine with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/outside-webhooks.test.mjs

// The documented ceiling for a webhook body (WEBHOOK_BODY_MAX_BYTES).
const BODY_LIMIT = 256 * 1024;
// The API stops waiting for a request body after this long (HTTP_RECEIVE_TIMEOUT_MS).
const RECEIVE_SECONDS = 30;
const person = {
  email: `hooks-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-5',
  name: 'Webhook Owner',
};
const record = createReport();

describe('webhooks from senders outside the server', () => {
  let internet;
  let server;
  let client;
  let workspaceId;
  let webhook;

  before(async () => {
    internet = await openInternet();
    server = await createPublicServer(internet);
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    await joinPrivateNetwork();
    client = publicClient(internet);
    await createOwner(server, client, person);
    workspaceId = await createWorkspace(client);
    webhook = await publishWebhookWorkflow(client, workspaceId);
  });
  after(async () => {
    if (process.env.DRILL_KEEP === 'true') return;
    await destroyServer();
    await closeInternet();
  });

  /** A signed delivery from the outside sender to the address Triggers shows. */
  const deliver = ({
    host = PUBLIC_HOSTS.app,
    eventId = randomUUID(),
    ...options
  } = {}) =>
    internet.request({
      method: 'POST',
      url: `https://${host}/hooks/${webhook.endpointKey}`,
      webhook: {
        signingSecret: webhook.signingSecret,
        bytes: options.bytes ?? 64,
        eventId,
      },
      headers: { 'idempotency-key': eventId, ...options.headers },
      pieces: options.pieces,
      pauseMillis: options.pauseMillis,
      timeout: 120_000,
    });
  const runCount = async () =>
    Number(await sql(server, 'select count(*) from app.workflow_runs'));

  it('starts a run from an outside sender through the public address', async () => {
    const sent = await deliver();
    assert.equal(sent.status, 202, JSON.stringify(sent));
    const runId = JSON.parse(sent.text).runId;
    await waitForSucceededRun(client, workspaceId, runId);
    record('outside delivery', { status: sent.status, millis: sent.millis });
  });

  it('does not take webhooks on the files name', async () => {
    const before = await runCount();
    const sent = await deliver({ host: PUBLIC_HOSTS.files });
    record('wrong host', { status: sent.status });
    assert.ok(sent.status >= 400, JSON.stringify(sent));
    assert.equal(await runCount(), before);
  });

  it("keeps the sender's trace and records the sender's address", async () => {
    const traceId = randomBytes(16).toString('hex');
    const sent = await deliver({
      headers: {
        traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`,
      },
    });
    assert.equal(sent.status, 202, sent.text);
    await waitForSucceededRun(client, workspaceId, JSON.parse(sent.text).runId);
    const spans = await waitFor(
      async () => {
        const traced = (await receivedSpans(server)).filter(
          (span) => span.traceId === traceId,
        );
        const services = new Set(traced.map((span) => span.service));
        return services.size >= 2 ? traced : undefined;
      },
      {
        what: "spans in the sender's trace from the API and the worker",
        timeout: 90_000,
        every: 3_000,
      },
    ).catch(async (error) => {
      record('trace and client address', {
        spansReceived: (await receivedSpans(server)).length,
        error: error.message,
      });
      throw error;
    });
    const ingress = spans.find((span) =>
      Object.values(span.attributes).some((value) => value.includes('/hooks/')),
    );
    const addresses = Object.fromEntries(
      Object.entries(ingress?.attributes ?? {}).filter(([key]) =>
        /address|client_ip|peer/u.test(key),
      ),
    );
    record('trace and client address', {
      services: [...new Set(spans.map((span) => span.service))],
      spanNames: spans.map((span) => `${span.service}: ${span.name}`),
      ingressAddresses: addresses,
    });
    assert.ok(ingress, 'an ingress span');
    assert.equal(
      addresses['client.address'] ?? addresses['http.client_ip'],
      INTERNET.sender,
    );
  });

  it('takes the largest allowed body and refuses one byte more without a run', async () => {
    const largest = await deliver({ bytes: BODY_LIMIT });
    assert.equal(largest.status, 202, largest.text);
    await waitForSucceededRun(
      client,
      workspaceId,
      JSON.parse(largest.text).runId,
    );
    const before = await runCount();
    const larger = await deliver({ bytes: BODY_LIMIT + 1 });
    record('body size', {
      atLimit: { status: largest.status, millis: largest.millis },
      overLimit: {
        status: larger.status,
        error: larger.error,
        text: larger.text?.slice(0, 300),
      },
    });
    assert.equal(larger.status, 413, JSON.stringify(larger));
    assert.equal(await runCount(), before);
  });

  it('takes a body trickled in over twenty seconds', async () => {
    const slow = await deliver({
      bytes: 32 * 1024,
      pieces: 10,
      pauseMillis: 2_000,
    });
    record('slow sender', { status: slow.status, millis: slow.millis });
    assert.equal(slow.status, 202, JSON.stringify(slow));
    await waitForSucceededRun(client, workspaceId, JSON.parse(slow.text).runId);
  });

  it('turns away a sender slower than the receive window, clearly and without a run', async () => {
    const before = await runCount();
    const pauseMillis = 5_000;
    const pieces = Math.ceil((RECEIVE_SECONDS + 15) / (pauseMillis / 1_000));
    const tooSlow = await deliver({ bytes: 32 * 1024, pieces, pauseMillis });
    record('too slow sender', {
      status: tooSlow.status,
      error: tooSlow.error,
      text: tooSlow.text?.slice(0, 300),
      millis: tooSlow.millis,
    });
    assert.equal(tooSlow.status, 408, JSON.stringify(tooSlow));
    assert.equal(await runCount(), before);
  });

  it('starts one run for a delivery the sender retries', async () => {
    const before = await runCount();
    const eventId = randomUUID();
    const first = await deliver({ eventId });
    const [again, concurrent] = await Promise.all([
      deliver({ eventId }),
      deliver({ eventId }),
    ]);
    const runIds = [first, again, concurrent].map(
      (response) => JSON.parse(response.text).runId,
    );
    record('retried delivery', {
      statuses: [first.status, again.status, concurrent.status],
      distinctRuns: new Set(runIds).size,
    });
    for (const response of [first, again, concurrent])
      assert.equal(response.status, 202, response.text);
    assert.equal(new Set(runIds).size, 1);
    await waitForSucceededRun(client, workspaceId, runIds[0]);
    assert.equal(await runCount(), before + 1);
    const run = await readRun(client, workspaceId, runIds[0]);
    assert.equal(run.run.status, 'succeeded');
  });
});
