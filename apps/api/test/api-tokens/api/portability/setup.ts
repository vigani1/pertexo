import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import {
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  apiTokenCreateResponseSchema,
} from '@pertexo/contracts';
import type { createAutomationApiFixture } from '../fixture.js';

export async function createTokenWorkspace(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
) {
  const { api } = caseFixture;

  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  const browser = await api.signIn(email);
  const workspace = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: 'Script authoring',
      slug: `script-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(workspace.statusCode).toBe(201);
  const workspaceId = workspace.json<{ id: string }>().id;
  const base = `/v1/workspaces/${workspaceId}`;
  const createdWorkflow = await api.send('POST', `${base}/workflows`, {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: { name: 'Pure script workflow' },
  });
  expect(createdWorkflow.statusCode).toBe(201);
  const workflowId = workflowCreateResponseSchema.parse(createdWorkflow.json())
    .workflow.id;
  const graph = {
    nodes: [
      {
        id: randomUUID(),
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        config: {},
        inputMappings: { value: { kind: 'run_input', path: '$.value' } },
        connectionRefs: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    settings: {},
  };
  const saved = await api.send('PUT', `${base}/workflows/${workflowId}/draft`, {
    browser,
    headers: { 'if-match': String(createdWorkflow.headers.etag) },
    payload: { graph },
  });
  expect(saved.statusCode).toBe(200);
  const draft = workflowDraftResponseSchema.parse(saved.json());
  async function credential(name: string) {
    const response = await api.send('POST', `${base}/api-tokens`, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name,
        scopes: [
          'workflow:read',
          'workflow:create',
          'workflow:publish',
          'run:read',
          'run:start',
          'run:cancel',
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const result = apiTokenCreateResponseSchema.parse(response.json());
    if (result.replayed) throw new Error('First creation replayed');
    return result;
  }
  const first = await credential('Deployment one');
  const second = await credential('Deployment two');
  const headers = { authorization: `Bearer ${first.secret}` };

  return {
    email,
    browser,
    workspaceId,
    base,
    workflowId,
    saved,
    draft,
    first,
    second,
    headers,
  };
}
