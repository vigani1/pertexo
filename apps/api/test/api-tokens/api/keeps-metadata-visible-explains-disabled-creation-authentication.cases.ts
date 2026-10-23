import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { apiTokenListResponseSchema } from '@pertexo/contracts';

import type { createDisabledAutomationFixture } from './fixture.js';

export function registerKeepsMetadataVisibleExplainsDisabledCreationAuthentication(
  caseFixture: ReturnType<typeof createDisabledAutomationFixture>,
): void {
  const { api } = caseFixture;

  it('keeps metadata visible and explains disabled creation and authentication', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const created = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Disabled automation',
        slug: `off-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json<{ id: string }>().id;
    const base = `/v1/workspaces/${workspaceId}`;
    const listed = await api.send('GET', `${base}/api-tokens`, { browser });
    expect(listed.statusCode).toBe(200);
    expect(apiTokenListResponseSchema.parse(listed.json())).toMatchObject({
      enabled: false,
      items: [],
    });
    const issued = await api.send('POST', `${base}/api-tokens`, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Not issued', scopes: ['run:read'] },
    });
    expect(issued.statusCode).toBe(503);
    expect(issued.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'api_token.unavailable',
      detail: 'Automation tokens are disabled on this server.',
    });
    const synthetic = `ptx_1.${workspaceId}.${randomUUID()}.${'A'.repeat(43)}`;
    const authenticated = await api.send('GET', `${base}/workflows`, {
      headers: { authorization: `Bearer ${synthetic}` },
    });
    expect(authenticated.statusCode).toBe(503);
    expect(authenticated.json<{ code: string }>().code).toBe(
      'api_token.unavailable',
    );
    const count = await api
      .database()
      .query<{ count: number }>(
        'select count(*)::int count from app.api_tokens where workspace_id=$1',
        [workspaceId],
      );
    expect(count.rows[0]?.count).toBe(0);
  });
}
