import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

const qualified = betterAuthIntegrationEnabled ? describe : describe.skip;
qualified('draft suite HTTP failures', () => {
  const api = useBetterAuthRealApi('suite_errors');
  let browser: Awaited<ReturnType<typeof api.signIn>>;
  let path: string;
  beforeAll(async () => {
    const email = `suite-${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    browser = await api.signIn(email);
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        name: 'Suite errors',
        slug: `suite-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = workspace.json<{ id: string }>().id;
    const workflow = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/workflows`,
      {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: { name: 'Suite error proof' },
      },
    );
    expect(workflow.statusCode).toBe(201);
    const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
      .id;
    path = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/test-suites`;
  });
  it.each(['suite', 'case report'] as const)(
    'returns a missing %s as 404',
    async (kind) => {
      const suffix =
        kind === 'suite' ? `/${randomUUID()}` : `/${randomUUID()}/cases/0`;
      const missing = await api.send('GET', `${path}${suffix}`, { browser });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'resource.not_found' });
    },
  );
  it('returns a refused admission with its safe workflow problem', async () => {
    const refused = await api.send('POST', path, {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        expectedRevision: 1,
        expectedSamples: [],
        expectedEffectfulSteps: [],
        expectedCases: [{ id: randomUUID(), revision: 1 }],
        expectedVariableSetRevision: null,
        signature: 'a'.repeat(64),
        acknowledgeSideEffects: false,
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'workflow.invalid' });
    expect(refused.json<{ detail: string }>().detail).toContain(
      'Save at least one input case',
    );
  });
});
