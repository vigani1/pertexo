import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { useBetterAuthRealApi } from '../support/better-auth/real-api.support.js';

export async function createPreviewBoundary(
  api: ReturnType<typeof useBetterAuthRealApi>,
) {
  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/workspaces');
  const browser = await api.signIn(email);
  const workspace = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: { name: 'Preview boundary', slug: `preview-${randomUUID()}` },
  });
  expect(workspace.statusCode, workspace.payload).toBe(201);
  const workspaceId = workspace.json<{ id: string }>().id;
  const root = `/v1/workspaces/${workspaceId}`;
  const created = await api.send('POST', `${root}/workflows`, {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: { name: 'Preview boundary' },
  });
  expect(created.statusCode, created.payload).toBe(201);
  const workflowId = created.json<{ workflow: { id: string } }>().workflow.id;
  const draft = `${root}/workflows/${workflowId}/draft`;
  const node = (id: string, key: string, inputMappings: object = {}) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings,
    connectionRefs: {},
  });
  async function save(inputMappings: object = {}) {
    const current = await api.send('GET', draft, { browser });
    const saved = await api.send('PUT', draft, {
      browser,
      headers: { 'if-match': String(current.headers.etag) },
      payload: {
        graph: {
          nodes: [
            node('manual', 'core.manual'),
            node('set', 'core.set', inputMappings),
          ],
          edges: [
            {
              id: 'manual-set',
              source: { nodeId: 'manual', port: 'out' },
              target: { nodeId: 'set', port: 'in' },
            },
          ],
          settings: {},
        },
      },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    return saved.json<{ revision: number }>().revision;
  }
  return { browser, root, draft, workflowId, workspaceId, save };
}
