import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { workflowDraftResponseSchema } from '@pertexo/contracts/workflow-authoring';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
} from '../../../../infrastructure/testing/curated-template-owned-fixture.mjs';
import {
  useBetterAuthRealApi,
  origin,
  type Browser,
} from '../support/better-auth-real-api.integration.support.js';

describe('owned ordinary Graph2 draft HTTP', () => {
  let browser: Browser;
  let base: string;
  beforeAll(async () => {
    await verifyCuratedFixtureOwnership();
  });
  const api = useBetterAuthRealApi('f08_draft', {
    beforeDrop: async () => {
      await verifyCuratedFixtureOwnership();
    },
  });
  beforeAll(async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    browser = await api.signIn(email);
    base = await api.listen();
  });
  async function send(
    method: string,
    path: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: browser.cookie,
        origin,
        'x-csrf-token': browser.csrf,
        'content-type': 'application/json',
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }
  async function draft(publishRetained = false) {
    const workspace = await send(
      'POST',
      '/v1/workspaces',
      { name: 'Owned draft HTTP', slug: `draft-${randomUUID()}` },
      { 'idempotency-key': randomUUID() },
    );
    expect(workspace.status).toBe(201);
    const workspaceId = ((await workspace.json()) as { id: string }).id;
    const workflows = `/v1/workspaces/${workspaceId}/workflows`;
    const created = await send(
      'POST',
      workflows,
      { name: 'Editable native draft' },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.status).toBe(201);
    const workflowId = ((await created.json()) as { workflow: { id: string } })
      .workflow.id;
    const route = `${workflows}/${workflowId}`;
    const initial = await send('GET', `${route}/draft`);
    expect(initial.status).toBe(200);
    const retained = workflowDraftResponseSchema.parse(await initial.json());
    expect(retained.schemaVersion).toBe(1);
    const node = (id: string, key: string, x: number) => ({
      id,
      definition: { key, version: 1 },
      configVersion: 1,
      config: {},
      connectionRefs: {},
      inputMappings:
        id === 'value'
          ? { value: { kind: 'literal', value: 'Retained mapping' } }
          : {},
      position: { x, y: 34 },
    });
    const ordinary = {
      ...retained.graph,
      nodes: [
        node('manual', 'core.manual', 21),
        node('value', 'core.set', 220),
      ],
      edges: [
        {
          id: 'manual-value',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'value', port: 'in' },
        },
      ],
    };
    const populated = await send(
      'PUT',
      `${route}/draft`,
      { graph: ordinary },
      { 'if-match': String(initial.headers.get('etag')) },
    );
    expect(populated.status, await populated.clone().text()).toBe(200);
    let versionId: string | undefined;
    if (publishRetained) {
      const published = await send(
        'POST',
        `${route}/publish`,
        {},
        {
          'if-match': String(populated.headers.get('etag')),
          'idempotency-key': randomUUID(),
        },
      );
      expect(published.status, await published.clone().text()).toBe(200);
      versionId = ((await published.json()) as { version: { id: string } })
        .version.id;
    }
    const graph = {
      ...ordinary,
      schemaVersion: 2,
      callable: {
        schemaVersion: 1,
        input: { type: 'object', properties: {}, required: [] },
        result: { type: 'object', properties: {}, required: [] },
        resultSelector: { kind: 'literal', value: {} },
      },
    };
    const saved = await send(
      'PUT',
      `${route}/draft`,
      { graph },
      { 'if-match': String(populated.headers.get('etag')) },
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    return { route, graph, saved, versionId };
  }
  it('persists the full native draft through fresh GET and ordinary conditional edits', async () => {
    const { route, graph, saved } = await draft();
    const tag = saved.headers.get('etag');
    expect(tag).toMatch(/^"draft-v2\.[A-Za-z0-9_-]{43}"$/u);
    const fresh = await send('GET', `${route}/draft`);
    expect(fresh.headers.get('etag')).toBe(tag);
    const reloaded = workflowDraftResponseSchema.parse(await fresh.json());
    expect(reloaded).toMatchObject({ schemaVersion: 2, revision: 3 });
    expect(reloaded.graph).toEqual(graph);
    const next = {
      ...graph,
      settings: { ...graph.settings, maxRunDurationMs: 10000 },
    };
    const edited = await send(
      'PUT',
      `${route}/draft`,
      { graph: next },
      { 'if-match': String(tag) },
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(edited.headers.get('etag')).not.toBe(tag);
    const stale = await send(
      'PUT',
      `${route}/draft`,
      { graph },
      { 'if-match': String(tag) },
    );
    expect(stale.status).toBe(412);
    const final = await send('GET', `${route}/draft`);
    const finalDraft = workflowDraftResponseSchema.parse(await final.json());
    expect(finalDraft.revision).toBe(4);
    expect(finalDraft.graph).toEqual(next);
    await recheckCuratedFixtureOwnership(await verifyCuratedFixtureOwnership());
  });
  it('reports native validation unavailable without turning valid source into a parser failure', async () => {
    const { route, saved } = await draft();
    const response = await send(
      'POST',
      `${route}/validate`,
      {},
      { 'if-match': String(saved.headers.get('etag')) },
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'workflow.draft_operation_unavailable',
    });
    expect(response.headers.get('retry-after')).toBeNull();
  });
  it('keeps ordinary mutation preconditions ahead of unsupported native operations', async () => {
    const { route, saved } = await draft();
    for (const [operation, payload] of [
      ['publish', {}],
      ['duplicate', { name: 'Native copy', source: { kind: 'draft' } }],
      [
        'export',
        { source: { kind: 'draft' }, reviewedGraphDigest: 'a'.repeat(64) },
      ],
    ] as const) {
      const headers = { 'idempotency-key': randomUUID() };
      const missing = await send(
        'POST',
        `${route}/${operation}`,
        payload,
        headers,
      );
      expect(missing.status, await missing.clone().text()).toBe(428);
      const stale = await send('POST', `${route}/${operation}`, payload, {
        ...headers,
        'if-match': `"draft-v2.${'a'.repeat(43)}"`,
      });
      expect(stale.status, await stale.clone().text()).toBe(412);
      const unavailable = await send('POST', `${route}/${operation}`, payload, {
        ...headers,
        'if-match': String(saved.headers.get('etag')),
      });
      expect(unavailable.status, await unavailable.clone().text()).toBe(409);
      expect(await unavailable.json()).toMatchObject({
        code: 'workflow.draft_operation_unavailable',
      });
      expect(unavailable.headers.get('retry-after')).toBeNull();
    }
    const final = await send('GET', `${route}/draft`);
    expect(final.headers.get('etag')).toBe(saved.headers.get('etag'));
  });
  it('keeps retained version restore explicit and preserves native draft truth', async () => {
    const { route, saved, versionId } = await draft(true);
    const restore = `${route}/versions/${String(versionId)}/restore`;
    expect((await send('POST', restore, {})).status).toBe(428);
    expect(
      (
        await send(
          'POST',
          restore,
          {},
          { 'if-match': `"draft-v2.${'a'.repeat(43)}"` },
        )
      ).status,
    ).toBe(412);
    const current = { 'if-match': String(saved.headers.get('etag')) };
    const missing = await send(
      'POST',
      `${route}/versions/${randomUUID()}/restore`,
      {},
      current,
    );
    expect(missing.status).toBe(404);
    const unavailable = await send('POST', restore, {}, current);
    expect(unavailable.status, await unavailable.clone().text()).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      code: 'workflow.draft_operation_unavailable',
    });
    const final = await send('GET', `${route}/draft`);
    expect(final.headers.get('etag')).toBe(saved.headers.get('etag'));
  });
});
