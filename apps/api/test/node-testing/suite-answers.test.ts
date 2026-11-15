import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkflowTestSuitesController } from '../../src/node-testing/suites/workflow-test-suites.controller.js';
import { WorkflowTestSuitesService } from '../../src/node-testing/suites/workflow-test-suites.service.js';
import { WORKSPACE_AUTHORIZATION } from '../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../support/identity-module.js';
import { ownerAccess, routeHarness } from '../support/route-harness.js';

const workspaceId = randomUUID();
const workflowId = randomUUID();
const suiteId = randomUUID();
const store = {
  prepare: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  report: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
};
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class SuiteAnswersUnderTest {}
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness({
    module: SuiteAnswersUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [WorkflowTestSuitesController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      {
        provide: WorkflowTestSuitesService,
        useValue: new WorkflowTestSuitesService(store, ownerAccess),
      },
    ],
  });
});
afterAll(() => harness.close());

describe('draft suite answers over HTTP', () => {
  it('fails with a server error rather than return a malformed stored report', async () => {
    store.report.mockResolvedValueOnce({
      report: { unbounded: 'x'.repeat(100_000) },
    });
    const reply = await harness.send(
      'GET',
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/test-suites/${suiteId}/cases/0`,
    );
    expect(reply.statusCode).toBe(500);
    expect(reply.body).not.toContain('xxxx');
  });
});
