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
      expect(response.json()).toMatchObject({
        code: 'request.invalid',
        detail: expect.stringMatching(/restart/i),
      });
    }
  });
});
