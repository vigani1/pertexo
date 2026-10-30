import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { waitFor } from './process.mjs';

// What a person does with the product, through its public HTTP surface. Only
// outcomes matter here, so the same steps run against any install.
const node = (id, key, config = {}, inputMappings = {}) => ({
  id,
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings,
  connectionRefs: {},
});
const edge = (id, source, target) => ({
  id,
  source: { nodeId: source, port: 'out' },
  target: { nodeId: target, port: 'in' },
});

export const signUp = (client, { email, password, name }) =>
  client.post('/v1/auth/sign-up/email', { email, password, name });

export const signIn = (client, { email, password }) =>
  client.post('/v1/auth/sign-in/email', { email, password });

export async function createWorkspace(client) {
  const suffix = randomUUID().slice(0, 8);
  const created = await client.post('/v1/workspaces', {
    name: `Drill ${suffix}`,
    slug: `drill-${suffix}`,
  });
  assert.equal(created.status, 201, created.text);
  return (created.json.workspace ?? created.json).id;
}

/** A published workflow: webhook, then a Code step, then the end. */
export async function publishWebhookWorkflow(client, workspaceId) {
  const workspace = `/v1/workspaces/${workspaceId}`;
  const created = await client.post(`${workspace}/workflows`, {
    name: `Drill ${randomUUID().slice(0, 8)}`,
  });
  assert.equal(created.status, 201, created.text);
  const workflow = `${workspace}/workflows/${created.json.workflow.id}`;
  const draft = await client.get(`${workflow}/draft`);
  const graph = {
    settings: {},
    nodes: [
      node('hook', 'core.webhook'),
      node('code', 'core.code', { code: 'return { answer: 40 + 2 };' }),
      node(
        'end',
        'core.terminate',
        {},
        { result: { kind: 'node_output', nodeId: 'code', path: '$' } },
      ),
    ],
    edges: [edge('first', 'hook', 'code'), edge('second', 'code', 'end')],
  };
  const saved = await client.put(
    `${workflow}/draft`,
    { graph },
    { headers: { 'if-match': draft.headers.etag } },
  );
  assert.equal(saved.status, 200, saved.text);
  const key = randomUUID();
  const published = await waitFor(
    async () => {
      const response = await client.post(`${workflow}/publish`, undefined, {
        headers: { 'if-match': saved.headers.etag, 'idempotency-key': key },
      });
      return response.status < 300 ? response : undefined;
    },
    { what: 'the workflow to publish', timeout: 60_000, every: 2_000 },
  );
  assert.ok(published);
  const triggers = await client.get(`${workflow}/triggers`);
  const trigger = (triggers.json.items ?? triggers.json.triggers)[0];
  // The endpoint is still being set up for a few seconds after publishing.
  const provisioned = await waitFor(
    async () => {
      const response = await client.post(
        `${workflow}/triggers/${trigger.id}/webhook/provision`,
      );
      if (response.status === 409) return undefined;
      assert.ok(response.status < 300, response.text);
      return response;
    },
    { what: 'the webhook endpoint', timeout: 90_000, every: 2_000 },
  );
  const { endpointKey, signingSecret } = provisioned.json;
  return { endpointKey, signingSecret };
}

/** A signed delivery, as the Triggers page tells a sender to make it. */
export async function sendWebhook(client, { endpointKey, signingSecret }) {
  const eventId = randomUUID();
  const body = Buffer.from(JSON.stringify({ eventId }));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac(
    'sha256',
    Buffer.from(signingSecret, 'base64url'),
  )
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  const response = await client.anonymous(
    'POST',
    `/hooks/${endpointKey}`,
    body,
    {
      'content-type': 'application/json',
      'idempotency-key': eventId,
      'x-pertexo-timestamp': timestamp,
      'x-pertexo-signature': `v1=${signature}`,
    },
  );
  assert.equal(response.status, 202, response.text);
  return response.json.runId;
}

export const readRun = async (client, workspaceId, runId) =>
  (await client.get(`/v1/workspaces/${workspaceId}/runs/${runId}`)).json;

export const waitForSucceededRun = (client, workspaceId, runId, timeout) =>
  waitFor(
    async () => {
      const run = await readRun(client, workspaceId, runId);
      const status = run?.run?.status ?? run?.status;
      if (status === 'failed' || status === 'cancelled')
        throw new Error(`Run ended ${status}: ${JSON.stringify(run)}`);
      return status === 'succeeded' ? run : undefined;
    },
    { what: `run ${runId} to succeed`, timeout: timeout ?? 120_000 },
  );

/** Uploads through the presigned address, as a browser does. */
export async function uploadFile(client, workspaceId, bytes) {
  const artifacts = `/v1/workspaces/${workspaceId}/artifacts`;
  const begun = await client.post(`${artifacts}/uploads`, {
    byteLength: bytes.length,
    mediaType: 'text/plain',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.equal(begun.status, 201, begun.text);
  const { artifact, upload } = begun.json;
  const stored = await client.anonymous(
    upload.method,
    upload.url,
    bytes,
    upload.headers,
  );
  assert.ok(stored.status < 300, `${stored.status} ${stored.text}`);
  const finalized = await client.post(
    `${artifacts}/${artifact.id}/finalize`,
    {},
  );
  assert.equal(finalized.status, 200, finalized.text);
  return artifact.id;
}

export async function downloadFile(client, workspaceId, artifactId) {
  const link = await client.get(
    `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/download`,
  );
  assert.equal(link.status, 200, link.text);
  const file = await client.anonymous('GET', link.json.url);
  assert.equal(file.status, 200, file.text);
  return file.bytes;
}
