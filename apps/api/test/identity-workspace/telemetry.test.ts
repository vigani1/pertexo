import { describe, expect, it, vi } from 'vitest';

import {
  createIdentityWorkspaceTelemetry,
  CreateWorkspaceUseCase,
  IDENTITY_WORKSPACE_METRIC_NAME,
  IDENTITY_WORKSPACE_OPERATION,
  type IdentityWorkspaceCounter,
  type IdentityWorkspaceHistogram,
  type IdentityWorkspaceMeter,
  type IdentityWorkspaceSpan,
  type IdentityWorkspaceTracer,
} from '../../src/identity-workspace/index.js';
import type { IdentityWorkspacePersistence } from '../../src/identity-workspace/ports.js';

describe('identity/workspace telemetry', () => {
  it('records successful use-case metrics and traces with fixed-cardinality attributes only', async () => {
    const fixture = telemetryFixture([1_000, 1_250]);
    const telemetry = createIdentityWorkspaceTelemetry(fixture.options);
    const persistence = workspacePersistence();
    const useCase = new CreateWorkspaceUseCase(persistence, telemetry);

    await useCase.execute({
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Operations',
      slug: 'operations',
      requestId: 'request-that-must-not-be-a-label',
      traceId: 'trace-that-must-not-be-a-label',
      metadata: { private: 'must-not-be-a-label' },
    });

    expect(fixture.traceNames).toEqual([
      'pertexo.identity_workspace.workspace.create',
    ]);
    expect(fixture.counter.add).toHaveBeenCalledWith(1, {
      operation: 'workspace.create',
      outcome: 'succeeded',
    });
    expect(fixture.histogram.record).toHaveBeenCalledWith(0.25, {
      operation: 'workspace.create',
      outcome: 'succeeded',
    });
    expect(fixture.span.setAttribute).toHaveBeenCalledTimes(2);
    expect(fixture.span.setAttribute).toHaveBeenNthCalledWith(
      1,
      'operation',
      'workspace.create',
    );
    expect(fixture.span.setAttribute).toHaveBeenNthCalledWith(
      2,
      'outcome',
      'succeeded',
    );
    expect(fixture.span.end).toHaveBeenCalledOnce();

    const serializedMeasurements = JSON.stringify([
      fixture.counter.add.mock.calls,
      fixture.histogram.record.mock.calls,
      fixture.span.setAttribute.mock.calls,
    ]);
    expect(serializedMeasurements).not.toContain('aaaaaaaa');
    expect(serializedMeasurements).not.toContain('request-that');
    expect(serializedMeasurements).not.toContain('trace-that');
    expect(serializedMeasurements).not.toContain('private');
  });

  it('records a bounded failed outcome and preserves the original error', async () => {
    const fixture = telemetryFixture([500, 510]);
    const telemetry = createIdentityWorkspaceTelemetry(fixture.options);
    const failure = new Error('provider payload must not become telemetry');

    await expect(
      telemetry.measure(IDENTITY_WORKSPACE_OPERATION.oidcCallback, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    expect(fixture.counter.add).toHaveBeenCalledWith(1, {
      operation: 'oidc.callback',
      outcome: 'failed',
    });
    expect(fixture.histogram.record).toHaveBeenCalledWith(0.01, {
      operation: 'oidc.callback',
      outcome: 'failed',
    });
    expect(JSON.stringify(fixture.span.setAttribute.mock.calls)).not.toContain(
      failure.message,
    );
    expect(fixture.span.end).toHaveBeenCalledOnce();
  });

  it('exposes only the six reviewed operation label values', () => {
    expect(Object.values(IDENTITY_WORKSPACE_OPERATION)).toEqual([
      'oidc.start',
      'oidc.callback',
      'session.logout',
      'workspace.create',
      'workspace.request_deletion',
      'workspace.restore',
    ]);
  });

  it('cannot change command truth when telemetry instruments fail', async () => {
    const instrumentFailure = createIdentityWorkspaceTelemetry({
      meter: {
        createCounter: () => {
          throw new Error('meter unavailable');
        },
        createHistogram: vi.fn(),
      },
      tracer: {
        startActiveSpan: vi.fn(),
      },
    });
    await expect(
      instrumentFailure.measure(
        IDENTITY_WORKSPACE_OPERATION.workspaceCreate,
        () => Promise.resolve('committed'),
      ),
    ).resolves.toBe('committed');

    const fixture = telemetryFixture([100, 110]);
    fixture.counter.add.mockImplementation(() => {
      throw new Error('export failed');
    });
    fixture.span.setAttribute.mockImplementation(() => {
      throw new Error('span failed');
    });
    fixture.span.end.mockImplementation(() => {
      throw new Error('span end failed');
    });
    const telemetry = createIdentityWorkspaceTelemetry(fixture.options);

    await expect(
      telemetry.measure(IDENTITY_WORKSPACE_OPERATION.workspaceCreate, () =>
        Promise.resolve('committed'),
      ),
    ).resolves.toBe('committed');
  });
});

function telemetryFixture(nowValues: readonly number[]) {
  const counter: IdentityWorkspaceCounter = { add: vi.fn() };
  const histogram: IdentityWorkspaceHistogram = { record: vi.fn() };
  const meter: IdentityWorkspaceMeter = {
    createCounter: vi.fn((name) => {
      expect(name).toBe(IDENTITY_WORKSPACE_METRIC_NAME.operations);
      return counter;
    }),
    createHistogram: vi.fn((name) => {
      expect(name).toBe(IDENTITY_WORKSPACE_METRIC_NAME.duration);
      return histogram;
    }),
  };
  const span: IdentityWorkspaceSpan = {
    end: vi.fn(),
    setAttribute: vi.fn(),
  };
  const traceNames: string[] = [];
  const tracer: IdentityWorkspaceTracer = {
    startActiveSpan: async (name, callback) => {
      traceNames.push(name);
      return callback(span);
    },
  };
  const values = [...nowValues];
  return {
    counter: counter as { add: ReturnType<typeof vi.fn> },
    histogram: histogram as { record: ReturnType<typeof vi.fn> },
    options: {
      meter,
      monotonicNow: (): number => values.shift() ?? 0,
      tracer,
    },
    span: span as {
      end: ReturnType<typeof vi.fn>;
      setAttribute: ReturnType<typeof vi.fn>;
    },
    traceNames,
  };
}

function workspacePersistence(): IdentityWorkspacePersistence {
  return {
    create: vi.fn(),
    findByDigest: vi.fn(),
    revokeByDigest: vi.fn(),
    resolveOrCreateIdentity: vi.fn(),
    createWorkspaceWithOwner: vi.fn().mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Operations',
      slug: 'operations',
      status: 'active',
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    }),
    requestWorkspaceDeletion: vi.fn(),
    restoreWorkspace: vi.fn(),
  };
}
