import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from '../node-testing/preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)('run continuation errors', () => {
  const api = useBetterAuthRealApi('run_cursors');
  it('accepts continuation and refuses malformed, foreign-workspace and changed-filter cursors as request errors', async () => {
    const f = await createPreviewBoundary(api);
    await f.save();
    const draft = await api.send('GET', f.draft, { browser: f.browser });
    const published = await api.send(
      'POST',
      `${f.root}/workflows/${f.workflowId}/publish`,
      {
        browser: f.browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(draft.headers.etag),
        },
      },
    );
    expect(published.statusCode, published.payload).toBe(200);
    for (let i = 0; i < 2; i++) {
      const run = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/runs`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {},
        },
      );
      expect(run.statusCode, run.payload).toBe(202);
    }
    const first = await api.send('GET', `${f.root}/runs?limit=1`, {
      browser: f.browser,
    });
    expect(first.statusCode, first.payload).toBe(200);
    const after = first.json<{ nextCursor: string }>().nextCursor;
    expect(after).toBeTypeOf('string');
    const valid = await api.send(
      'GET',
      `${f.root}/runs?limit=1&after=${after}`,
      { browser: f.browser },
    );
    expect(valid.statusCode, valid.payload).toBe(200);
    const runIds = (body: { items: { id: string }[] }) =>
      body.items.map(({ id }) => id);
    const page1 = runIds(first.json());
    const page2 = runIds(valid.json());
    expect(page2).toHaveLength(1);
    expect(page2).not.toEqual(page1);
    // Filters pass through paging as given; another filter set can't reuse
    // the cursor (below).
    const filtered = await api.send(
      'GET',
      `${f.root}/runs?workflowId=${f.workflowId}&status=queued&limit=1`,
      { browser: f.browser },
    );
    expect(filtered.statusCode, filtered.payload).toBe(200);
    const filteredAfter = filtered.json<{ nextCursor: string }>().nextCursor;
    const filteredNext = await api.send(
      'GET',
      `${f.root}/runs?workflowId=${f.workflowId}&status=queued&limit=1&after=${filteredAfter}`,
      { browser: f.browser },
    );
    expect(filteredNext.statusCode, filteredNext.payload).toBe(200);
    expect(
      new Set([...runIds(filtered.json()), ...runIds(filteredNext.json())])
        .size,
    ).toBe(2);
    for (const query of ['status=succeeded', 'runValueKey=orderId&runValue=']) {
      const none = await api.send('GET', `${f.root}/runs?${query}`, {
        browser: f.browser,
      });
      expect(none.statusCode, `${query} ${none.payload}`).toBe(200);
      expect(none.json()).toEqual({ items: [], nextCursor: null });
    }
    const made = await api.send('POST', '/v1/workspaces', {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Other workspace', slug: `other-${randomUUID()}` },
    });
    expect(made.statusCode, made.payload).toBe(201);
    const other = { root: `/v1/workspaces/${made.json<{ id: string }>().id}` };
    for (const path of [
      `${f.root}/runs?after=e30`,
      `${f.root}/runs?status=failed&after=${after}`,
      `${other.root}/runs?after=${after}`,
    ]) {
      const response = await api.send('GET', path, { browser: f.browser });
      expect(response.statusCode, response.payload).toBe(400);
      expect(response.json<{ detail: string }>().detail).toMatch(/restart/i);
      expect(response.json()).toMatchObject({
        code: 'request.invalid',
      });
    }
  });
});
