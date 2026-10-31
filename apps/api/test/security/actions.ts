import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Reply, Stack } from './stack.js';

export const PASSWORD = 'a long enough integration password';

export type Browser = Readonly<{ cookie: string; csrf: string }>;

export function browserFrom(reply: Reply): Browser {
  const cookies = reply.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '');
  const csrf = cookies
    .find((value) => /csrf/iu.test(value.split('=')[0] ?? ''))
    ?.split('=')[1];
  if (csrf === undefined) throw new Error('Sign-in set no CSRF cookie');
  return { cookie: cookies.join('; '), csrf };
}

/** Signs up and verifies through the link the API printed for this address. */
export async function registerAccount(stack: Stack, email: string) {
  const created = await stack.send('POST', '/v1/auth/sign-up/email', {
    body: {
      name: 'Person',
      email,
      password: PASSWORD,
      callbackURL: '/workspaces',
    },
  });
  if (created.status !== 200)
    throw new Error(
      `Sign-up refused: ${String(created.status)} ${created.text}`,
    );
  await followVerificationLink(stack, email);
}

export async function followVerificationLink(stack: Stack, email: string) {
  const link = await printedLink(stack, email);
  return stack.send('GET', link.pathname + link.search);
}

async function printedLink(stack: Stack, email: string): Promise<URL> {
  const heading = `verification for ${email}\n`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const at = stack.api.logs.lastIndexOf(heading);
    if (at >= 0) {
      const url = stack.api.logs.slice(at + heading.length).split('\n')[0];
      if (url !== undefined && url.length > 0) return new URL(url);
    }
    await delay(50);
  }
  throw new Error(`No verification link printed for ${email}`);
}

export async function signIn(stack: Stack, email: string): Promise<Browser> {
  const reply = await stack.send('POST', '/v1/auth/sign-in/email', {
    body: { email, password: PASSWORD, callbackURL: '/workspaces' },
  });
  if (reply.status !== 200)
    throw new Error(`Sign-in refused: ${String(reply.status)} ${reply.text}`);
  return browserFrom(reply);
}

export async function createWorkspace(stack: Stack, browser: Browser) {
  const reply = await stack.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    body: { name: 'Security', slug: `sec-${randomUUID().slice(0, 8)}` },
  });
  if (reply.status !== 201) throw new Error(reply.text);
  return (reply.json() as { id: string }).id;
}

/** Publishes a graph through the same requests the editor makes. */
export async function publishWorkflow(
  stack: Stack,
  browser: Browser,
  workspaceId: string,
  graph: Readonly<{ nodes: unknown[]; edges: unknown[] }>,
) {
  const base = `/v1/workspaces/${workspaceId}/workflows`;
  const created = await stack.send('POST', base, {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    body: { name: `Workflow ${randomUUID().slice(0, 8)}` },
  });
  if (created.status !== 201) throw new Error(created.text);
  const workflowId = (created.json() as { workflow: { id: string } }).workflow
    .id;
  const path = `${base}/${workflowId}`;
  const draft = await stack.send('GET', `${path}/draft`, { browser });
  const saved = await stack.send('PUT', `${path}/draft`, {
    browser,
    headers: { 'if-match': draft.headers.get('etag') ?? '' },
    body: { graph: { settings: {}, ...graph } },
  });
  if (saved.status !== 200) throw new Error(saved.text.slice(200));
  const published = await stack.send('POST', `${path}/publish`, {
    browser,
    headers: {
      'if-match': saved.headers.get('etag') ?? '',
      'idempotency-key': randomUUID(),
    },
    body: {},
  });
  if (published.status !== 200 && published.status !== 201)
    throw new Error(
      `Publish: ${String(published.status)} ${published.text.slice(0, 1_000)}`,
    );
  return { workflowId, path };
}

export type NodeInput = Readonly<{
  id: string;
  key: string;
  config?: unknown;
  inputMappings?: unknown;
}>;

export function graphOf(nodes: readonly NodeInput[]) {
  return {
    nodes: nodes.map((node, index) => ({
      id: node.id,
      definition: { key: node.key, version: 1 },
      position: { x: index * 280, y: 0 },
      configVersion: 1,
      config: node.config ?? {},
      inputMappings: node.inputMappings ?? {},
      connectionRefs: {},
    })),
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${String(index)}`,
      source: { nodeId: nodes[index]?.id, port: 'out' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
}

/** Gives a published webhook trigger a public secret URL and returns it. */
export async function openSecretUrlEndpoint(
  stack: Stack,
  browser: Browser,
  workflowPath: string,
): Promise<string> {
  // The worker materializes a published trigger shortly after publishing.
  let triggerId: string | undefined;
  for (let waited = 0; triggerId === undefined; waited += 200) {
    const listed = await stack.send('GET', `${workflowPath}/triggers`, {
      browser,
    });
    if (listed.status !== 200) throw new Error(listed.text);
    const [trigger] = (
      listed.json() as { items: { id: string; status: string }[] }
    ).items;
    if (trigger?.status === 'configuration_required') triggerId = trigger.id;
    else if (waited > 30_000)
      throw new Error(`Webhook never became ready: ${listed.text}`);
    else await delay(200);
  }
  const provisioned = await stack.send(
    'POST',
    `${workflowPath}/triggers/${triggerId}/webhook/provision`,
    { browser, headers: { 'idempotency-key': randomUUID() } },
  );
  if (provisioned.status !== 200 && provisioned.status !== 201)
    throw new Error(provisioned.text);
  const configured = await stack.send(
    'POST',
    `${workflowPath}/triggers/${triggerId}/webhook/authentication`,
    {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      body: { mode: 'secret_url', allowedOrigins: [] },
    },
  );
  if (configured.status !== 200) throw new Error(configured.text);
  return `/hooks/${(configured.json() as { endpointKey: string }).endpointKey}`;
}
