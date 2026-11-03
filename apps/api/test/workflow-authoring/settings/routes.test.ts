import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { WorkflowConcurrencyController } from '../../../src/workflow-authoring/settings/concurrency-controller.js';
import { WorkflowConcurrencyUseCase } from '../../../src/workflow-authoring/settings/concurrency.js';
import { WorkflowErrorController } from '../../../src/workflow-authoring/settings/error-workflow-controller.js';
import { WorkflowErrorUseCase } from '../../../src/workflow-authoring/settings/error-workflow.js';
import {
  WorkflowAutoPauseController,
  WorkspaceAutoPauseController,
} from '../../../src/workflow-authoring/settings/auto-pause-controllers.js';
import { WorkflowAutoPauseUseCase } from '../../../src/workflow-authoring/settings/auto-pause.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflow = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
const settings = {
  asOf: '2026-10-01T00:00:00.000001Z',
  limit: null,
  revision: 1,
  workspaceActiveRunLimit: null,
  workspacePolicyState: 'unavailable',
  overflow: 'queue',
};

const concurrency = { read: vi.fn(), update: vi.fn() };
const errorWorkflow = { targets: vi.fn(), read: vi.fn(), update: vi.fn() };
const autoPause = {
  readWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  resume: vi.fn(),
  readWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
};
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class SettingsRoutesUnderTest {}
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness({
    module: SettingsRoutesUnderTest,
    imports: [{ module: FakeIdentityModule }],
    controllers: [
      WorkflowConcurrencyController,
      WorkflowErrorController,
      WorkflowAutoPauseController,
      WorkspaceAutoPauseController,
    ],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      { provide: WorkflowConcurrencyUseCase, useValue: concurrency },
      { provide: WorkflowErrorUseCase, useValue: errorWorkflow },
      { provide: WorkflowAutoPauseUseCase, useValue: autoPause },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  concurrency.read.mockResolvedValue(settings);
  concurrency.update.mockResolvedValue({ settings, replayed: true });
});

const put = (url: string, body: unknown, key = 'setting-once') =>
  harness.send('PUT', url, { body, headers: { 'idempotency-key': key } });
const untouched = () => {
  for (const useCase of [concurrency, errorWorkflow, autoPause])
    for (const method of Object.values(useCase))
      expect(method).not.toHaveBeenCalled();
};

describe('workflow settings routes', () => {
  it('reads and changes concurrency with no copy kept by caches', async () => {
    const read = await harness.send('GET', `${workflow}/concurrency`);
    const changed = await put(`${workflow}/concurrency`, {
      limit: null,
      expectedRevision: 1,
    });
    expect(read.statusCode, read.payload).toBe(200);
    expect(changed.statusCode, changed.payload).toBe(200);
    expect(changed.json()).toEqual({ settings, replayed: true });
    for (const reply of [read, changed])
      expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(concurrency.update).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        request: { limit: null, expectedRevision: 1 },
        idempotencyKey: 'setting-once',
      }),
    );
  });

  it.each([
    { limit: 0, expectedRevision: 1 },
    { limit: 10_001, expectedRevision: 1 },
    { limit: 1, expectedRevision: 2_147_483_648 },
    { limit: null, expectedRevision: 0 },
    { limit: 1, expectedRevision: 1, overflow: 'drop' },
  ])('refuses concurrency change %j before any write', async (body) => {
    expect((await put(`${workflow}/concurrency`, body)).statusCode).toBe(400);
    untouched();
  });

  it('refuses a folded idempotency key and a non-UUID workflow', async () => {
    const folded = await put(
      `${workflow}/concurrency`,
      { limit: null, expectedRevision: 1 },
      'one,two',
    );
    const bad = await harness.send(
      'GET',
      `/v1/workspaces/${workspaceId}/workflows/bad/concurrency`,
    );
    for (const reply of [folded, bad]) {
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'request.invalid' });
    }
    untouched();
  });

  it.each([
    { targetWorkflowId: workflowId, expectedRevision: 0 },
    { targetWorkflowId: 'foreign-id', expectedRevision: 1 },
    { targetWorkflowId: null, expectedRevision: 1, input: { password: 's' } },
    { targetWorkflowId: null, expectedRevision: 1, targetWorkflowName: 'x' },
  ])('refuses error-workflow setting %j before any write', async (body) => {
    expect((await put(`${workflow}/error-workflow`, body)).statusCode).toBe(
      400,
    );
    untouched();
  });

  it.each([
    { enabled: true, thresholdOverride: 2, expectedSettingsRevision: 1 },
    { enabled: true, thresholdOverride: 101, expectedSettingsRevision: 1 },
    {
      enabled: true,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
      warning: true,
    },
  ])('refuses automatic pause setting %j before any write', async (body) => {
    expect((await put(`${workflow}/auto-pause`, body)).statusCode).toBe(400);
    untouched();
  });

  it.each([
    // A pause revision is text now; a number is the old form, refused.
    [{ expectedPauseRevision: 9007199254740992 }, 'single'],
    [{ expectedPauseRevision: 1 }, 'single'],
    [{ expectedPauseRevision: '1' }, 'one,two'],
  ])('refuses resume %j with key %j before any write', async (body, key) => {
    const reply = await harness.send('POST', `${workflow}/resume`, {
      body,
      headers: { 'idempotency-key': key },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({ code: 'request.invalid' });
    untouched();
  });
});
