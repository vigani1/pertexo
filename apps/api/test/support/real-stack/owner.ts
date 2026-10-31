import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { expect } from 'vitest';

import type { RealStack } from './stack.js';

const password = 'a long enough integration password';

/** Signs one person up over real HTTP; sign-ups are rate limited, so a suite shares them. */
export async function signUp(stack: RealStack, origin: string) {
  const email = `stack-${randomUUID()}@example.test`;
  const headers = { origin, 'content-type': 'application/json' };
  const created = await fetch(`${origin}/v1/auth/sign-up/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Stack owner',
      email,
      password,
      callbackURL: '/workspaces',
    }),
  });
  expect(created.status, await created.text()).toBe(200);
  await stack.verifyEmail(email);
  const signedIn = await fetch(`${origin}/v1/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, callbackURL: '/workspaces' }),
  });
  expect(signedIn.status, await signedIn.text()).toBe(200);
  const cookies = signedIn.headers.getSetCookie();
  const cookie = (name: string) => {
    const value = cookies
      .find((entry) => entry.startsWith(`${name}=`))
      ?.split(';', 1)[0]
      ?.slice(name.length + 1);
    if (value === undefined) throw new Error(`${name} cookie missing`);
    return value;
  };
  const session = cookie('pertexo_session');
  const csrf = cookie('pertexo_csrf');
  return function send(
    method: string,
    path: string,
    payload?: unknown,
    extra: Readonly<Record<string, string>> = {},
  ) {
    return fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie: `pertexo_session=${session}; pertexo_csrf=${csrf}`,
        'x-csrf-token': decodeURIComponent(csrf),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  };
}

/** A workspace of its own, so one test's runs don't count against another's. */
export async function ownWorkspace(send: Awaited<ReturnType<typeof signUp>>) {
  const workspace = await send('POST', '/v1/workspaces', {
    name: 'Stack',
    slug: `stack-${randomUUID().slice(0, 8)}`,
  });
  expect(workspace.status).toBe(201);
  const { id: workspaceId } = (await workspace.json()) as { id: string };
  return { send, workspaceId, base: `/v1/workspaces/${workspaceId}` };
}

export type StackOwner = Awaited<ReturnType<typeof ownWorkspace>>;

export const step = (
  id: string,
  key: string,
  x: number,
  config: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  definition: { key, version: 1 },
  position: { x, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});

/** Saves a graph over the draft and publishes it, as the editor does. */
export async function publishDraft(
  owner: StackOwner,
  path: string,
  graph: Readonly<{ nodes: unknown[]; edges: unknown[] }>,
) {
  const draft = await owner.send('GET', `${path}/draft`);
  const saved = await owner.send(
    'PUT',
    `${path}/draft`,
    { graph: { settings: {}, ...graph } },
    { 'if-match': String(draft.headers.get('etag')) },
  );
  const savedBody = await saved.text();
  expect(saved.status, savedBody).toBe(200);
  return publishCurrentDraft(owner, path, String(saved.headers.get('etag')));
}

export async function publishCurrentDraft(
  owner: StackOwner,
  path: string,
  etag: string,
) {
  // The API asks for a retry when validation is saturated on a busy machine.
  for (let tries = 1; ; tries += 1) {
    const published = await owner.send('POST', `${path}/publish`, undefined, {
      'if-match': etag,
    });
    const publishedBody = await published.text();
    if (published.status === 503 && tries < 5) {
      await delay(1_000);
      continue;
    }
    expect(published.status, publishedBody).toBe(200);
    return (JSON.parse(publishedBody) as { version: { id: string } }).version
      .id;
  }
}

export async function publishGraph(
  owner: StackOwner,
  name: string,
  graph: Readonly<{ nodes: unknown[]; edges: unknown[] }>,
) {
  const created = await owner.send('POST', `${owner.base}/workflows`, { name });
  expect(created.status).toBe(201);
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  const path = `${owner.base}/workflows/${workflow.id}`;
  const versionId = await publishDraft(owner, path, graph);
  return { path, workflowId: workflow.id, versionId };
}

export async function usageCapacity(owner: StackOwner) {
  const response = await owner.send('GET', `${owner.base}/usage-capacity`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    execution: {
      activeRuns: number;
      queuedRuns: number;
      policy: { activeRunLimit: number; queuedRunLimit: number };
    };
    artifacts: { artifactCountLimit: number };
  };
}

/** A signed delivery with its own key, as a real sender would send it. */
export function signedDelivery(
  origin: string,
  endpointKey: string,
  secret: string,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.{}`)
    .digest('hex')}`;
  return fetch(`${origin}/hooks/${endpointKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-pertexo-timestamp': timestamp,
      'x-pertexo-signature': signature,
    },
    body: '{}',
  });
}

export async function startRun(owner: StackOwner, path: string) {
  const started = await owner.send('POST', `${path}/runs`, { input: {} });
  const body = await started.text();
  expect(started.status, body).toBe(202);
  return (JSON.parse(body) as { run: { id: string } }).run.id;
}

export async function readRun(owner: StackOwner, runId: string) {
  const read = await owner.send('GET', `${owner.base}/runs/${runId}`);
  const { run } = (await read.json()) as {
    run: { status: string; workflowVersionId: string };
  };
  return run;
}

export async function runReaches(
  owner: StackOwner,
  runId: string,
  status: string,
) {
  await expect
    .poll(async () => (await readRun(owner, runId)).status, {
      timeout: 30_000,
      interval: 250,
    })
    .toBe(status);
}

export async function listTriggers(owner: StackOwner, path: string) {
  const listed = await owner.send('GET', `${path}/triggers`);
  expect(listed.status).toBe(200);
  const { items } = (await listed.json()) as {
    items: {
      id: string;
      kind: string;
      nodeId: string;
      status: string;
      endpointReady: boolean;
    }[];
  };
  return items;
}

/** Provisions the one webhook step of a just-published workflow, once the worker has its trigger. */
export async function provisionWebhook(owner: StackOwner, path: string) {
  let triggerId: string | undefined;
  await expect
    .poll(
      async () => {
        triggerId = (await listTriggers(owner, path)).find(
          ({ status }) => status === 'configuration_required',
        )?.id;
        return triggerId !== undefined;
      },
      { timeout: 30_000, interval: 250 },
    )
    .toBe(true);
  const provisioned = await owner.send(
    'POST',
    `${path}/triggers/${String(triggerId)}/webhook/provision`,
  );
  expect(provisioned.status).toBe(200);
  return (await provisioned.json()) as {
    endpointKey: string;
    signingSecret: string;
  };
}
