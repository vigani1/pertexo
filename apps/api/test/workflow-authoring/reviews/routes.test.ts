import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { WorkflowPublicationReviewController } from '../../../src/workflow-authoring/reviews/controller.js';
import { PublicationReviewUseCase } from '../../../src/workflow-authoring/reviews/use-case.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const url = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/publication-review`;
const representationTag = `"draft.${'a'.repeat(43)}"`;
const reviews = { request: vi.fn(), overview: vi.fn() };
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ReviewRoutesUnderTest {}
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness({
    module: ReviewRoutesUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [WorkflowPublicationReviewController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      { provide: PublicationReviewUseCase, useValue: reviews },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => vi.clearAllMocks());

const request = (body: unknown, headers: Record<string, string>) =>
  harness.send('POST', url, {
    body,
    headers: { 'idempotency-key': 'one-request', ...headers },
  });

describe('publication review request route', () => {
  it('passes the trimmed note and the exact draft tag', async () => {
    await request(
      { note: '  Review this change.  ' },
      { 'if-match': representationTag },
    );
    expect(reviews.request).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        request: { note: 'Review this change.' },
        representationTag,
        idempotencyKey: 'one-request',
      }),
    );
  });

  it('refuses a body with fields a review request has no place for', async () => {
    const reply = await request(
      { note: '', graph: {} },
      { 'if-match': representationTag },
    );
    expect(reply.statusCode).toBe(400);
    expect(reviews.request).not.toHaveBeenCalled();
  });

  it('asks for the draft tag when none is sent', async () => {
    const reply = await request({ note: 'Review' }, {});
    expect(reply.statusCode).toBe(428);
    expect(reviews.request).not.toHaveBeenCalled();
  });
});
