import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import {
  getWorkflowDraft,
  saveWorkflowDraft,
} from '@/features/workflow-editor/workflow-editor.api';
import {
  emptyCallableDeclaration,
  setCallableDeclaration,
} from '@/features/workflow-editor/model/graph/callable-contract';
import {
  draftBody,
  emptyGraph,
  workflowId,
  workspaceId,
} from '../../support/workflow-editor-fixtures';

const etag = `"draft-v2.${'n'.repeat(43)}"`;
const graph = setCallableDeclaration(emptyGraph, emptyCallableDeclaration());

function response(body = draftBody(graph, 4)) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', etag },
  });
}

describe('native draft browser transport', () => {
  it('reads a native declaration without interpreting its opaque ETag', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response());
    const api = createApiClient({ fetch, readCsrfToken: () => undefined });
    await expect(
      getWorkflowDraft(api, workspaceId, workflowId),
    ).resolves.toMatchObject({ etag, draft: { schemaVersion: 2, graph } });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('conditionally saves and decodes native drafts through the existing PUT endpoint', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response());
    const api = createApiClient({
      fetch,
      readCsrfToken: () => 'csrf-token-1234567890',
    });
    await expect(
      saveWorkflowDraft(api, workspaceId, workflowId, { graph, etag }),
    ).resolves.toMatchObject({ etag, draft: { graph } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    );
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('if-match')).toBe(etag);
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe(
      'csrf-token-1234567890',
    );
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({ graph });
  });
  it('does not silently accept a retained response envelope around a native graph', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response({ ...draftBody(graph, 4), schemaVersion: 1 }),
      );
    const api = createApiClient({ fetch, readCsrfToken: () => undefined });
    await expect(
      getWorkflowDraft(api, workspaceId, workflowId),
    ).rejects.toBeDefined();
  });
});
