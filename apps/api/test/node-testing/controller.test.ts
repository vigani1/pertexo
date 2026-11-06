import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { NodeTestingModule } from '../../src/node-testing/node-testing.module.js';
import { FakeIdentityModule } from '../support/identity-module.js';
import { routeHarness } from '../support/route-harness.js';
import {
  nodeTestingDependencies,
  nodeTestingIds,
  nodeTestingPreview,
} from './node-testing.fixture.js';

const { actorId, workspaceId, workflowId, previewRunId } = nodeTestingIds;
const draft = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
const nodeTest = `${draft}/nodes/http/test`;
const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const validate = {
  mode: 'validate',
  expectedRevision: 3,
  sampleInput: { body: { encoding: 'utf8', value: 'hello' } },
};
const execute = {
  mode: 'test_execute',
  expectedRevision: 3,
  acknowledgeSideEffects: true,
  input: { kind: 'manual', value: { body: { encoding: 'utf8', value: 'hi' } } },
};

const dependencies = nodeTestingDependencies();
const { persistence } = dependencies;
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness(
    NodeTestingModule.register(dependencies, { module: FakeIdentityModule }),
  );
});
afterAll(() => harness.close());
beforeEach(() => vi.clearAllMocks());

const testNode = (body: unknown, headers: Record<string, string> = {}) =>
  harness.send('POST', nodeTest, { body, headers });

describe('node test route', () => {
  it('validates at 200 without needing or reading an idempotency key', async () => {
    const reply = await testNode(validate, { 'idempotency-key': 'a,b' });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.json()).toMatchObject({ mode: 'validate', valid: true });
    expect(persistence.acceptPreview).not.toHaveBeenCalled();
  });

  it('accepts a durable test at 202 and carries the trace context', async () => {
    const reply = await testNode(execute, {
      'idempotency-key': 'preview-key',
      traceparent,
    });
    expect(reply.statusCode, reply.payload).toBe(202);
    expect(reply.json()).toMatchObject({
      mode: 'test_execute',
      preview: { id: previewRunId, status: 'queued' },
    });
    expect(persistence.acceptPreview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ traceparent }),
    );
  });

  it.each([[undefined], [''], ['contains space'], ['first,second']])(
    'refuses execution with idempotency key %j before any preview work',
    async (key) => {
      const reply = await testNode(
        execute,
        key === undefined ? {} : { 'idempotency-key': key },
      );
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'request.invalid' });
      expect(persistence.resolvePreviewReplay).not.toHaveBeenCalled();
      expect(persistence.acceptPreview).not.toHaveBeenCalled();
    },
  );

  it('refuses deeply nested input as a bad request before reading the draft', async () => {
    const deep = `${'['.repeat(10_000)}null${']'.repeat(10_000)}`;
    const reply = await harness.send('POST', nodeTest, {
      json: `{"mode":"validate","expectedRevision":3,"sampleInput":${deep}}`,
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({ code: 'request.invalid' });
    expect(persistence.getDraft).not.toHaveBeenCalled();
  });

  it('reads one preview for the signed-in actor', async () => {
    persistence.readPreview.mockResolvedValueOnce(nodeTestingPreview());
    const reply = await harness.send(
      'GET',
      `/v1/workspaces/${workspaceId}/previews/${previewRunId}`,
    );
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.json()).toMatchObject({
      preview: { id: previewRunId, status: 'queued', output: null },
    });
    expect(persistence.readPreview).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      actorUserId: actorId,
      previewRunId,
    });
  });
});

describe('draft test routes', () => {
  const testRequest = {
    expectedRevision: 3,
    expectedSamples: [],
    expectedEffectfulSteps: [],
    input: {},
    acknowledgeSideEffects: false,
  };
  const suiteRequest = {
    expectedRevision: 1,
    expectedSamples: [],
    expectedEffectfulSteps: ['http'],
    expectedCases: [{ id: previewRunId, revision: 2 }],
    expectedVariableSetRevision: 3,
    signature: 'a'.repeat(64),
    acknowledgeSideEffects: true,
  };
  const start = (path: string, body: unknown) =>
    harness.send('POST', `${draft}/${path}`, {
      body,
      headers: { 'idempotency-key': 'draft-test' },
    });

  it.each([
    { ...testRequest, acknowledgeSideEffects: 'yes' },
    { ...testRequest, expectedEffectfulSteps: undefined },
    { ...testRequest, overrides: {} },
  ])('refuses test command %j before storage', async (body) => {
    const reply = await start('tests', body);
    expect(reply.statusCode).toBe(400);
    expect(persistence.workflowTests.start).not.toHaveBeenCalled();
  });

  it.each([
    { ...suiteRequest, acknowledgeSideEffects: 'yes' },
    { ...suiteRequest, signature: 'old' },
    { ...suiteRequest, expectedCases: [] },
    {
      ...suiteRequest,
      expectedCases: Array.from({ length: 51 }, (_, revision) => ({
        id: previewRunId,
        revision: revision + 1,
      })),
    },
    { ...suiteRequest, input: {} },
  ])('refuses suite manifest %# before storage', async (body) => {
    const reply = await start('test-suites', body);
    expect(reply.statusCode).toBe(400);
    expect(persistence.workflowTestSuites.start).not.toHaveBeenCalled();
  });

  it('refuses a case ordinal outside the suite before reading', async () => {
    const reply = await harness.send(
      'GET',
      `${draft}/test-suites/${previewRunId}/cases/50`,
    );
    expect(reply.statusCode).toBe(400);
    expect(persistence.workflowTestSuites.report).not.toHaveBeenCalled();
  });
});
