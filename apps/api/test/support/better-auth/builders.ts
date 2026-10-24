import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { useBetterAuthRealApi } from './api/instance.js';
import type { Browser } from './api/contract.js';

type Api = ReturnType<typeof useBetterAuthRealApi>;

export async function signedInAccount(api: Api) {
  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  const owner = await api.signIn(email);
  return { email, owner };
}

export async function workspaceFor(
  api: Api,
  owner: Browser,
  options: Readonly<{ name: string; slugPrefix: string }>,
) {
  const response = await api.send('POST', '/v1/workspaces', {
    browser: owner,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: options.name,
      slug: `${options.slugPrefix}-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return response.json<{ id: string }>().id;
}

export async function workflowFor(
  api: Api,
  owner: Browser,
  options: Readonly<{ workspaceId: string; name: string }>,
) {
  const response = await api.send(
    'POST',
    `/v1/workspaces/${options.workspaceId}/workflows`,
    {
      browser: owner,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: options.name },
    },
  );
  expect(response.statusCode, response.payload).toBe(201);
  return response.json<{ workflow: { id: string } }>().workflow.id;
}
