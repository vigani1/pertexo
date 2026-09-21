import { describe, expect, it } from 'vitest';

import {
  workflowRunCancelRequestSchema,
  workflowRunListQuerySchema,
  workflowRunReplayRequestSchema,
  workflowRunListResponseSchema,
  workflowRunStartRequestSchema,
} from '../src/http/workflow-runs.js';
import {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from '../src/workflow-runs.js';

describe('workflow-run public contracts', () => {
  it('accepts explicit public commands without exposing engine state', () => {
    expect(
      workflowRunStartRequestSchema.safeParse({
        input: { customerId: 'customer-42' },
        deadlineAt: '2026-08-21T18:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      workflowRunStartRequestSchema.safeParse({
        input: {},
        initialCheckpoint: { revision: 0 },
      }).success,
    ).toBe(false);
    expect(
      workflowRunCancelRequestSchema.safeParse({ reason: 'operator request' })
        .success,
    ).toBe(true);
    expect(
      workflowRunCancelRequestSchema.safeParse({ reason: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      workflowRunReplayRequestSchema.safeParse({
        workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        input: null,
      }).success,
    ).toBe(true);
    expect(
      workflowRunReplayRequestSchema.safeParse({
        workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }).success,
    ).toBe(false);
  });

  it('documents acceptance, cancellation, replay, reads and SSE independently', () => {
    expect(Object.keys(workflowRunsOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/runs',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs',
      '/v1/workspaces/{workspaceId}/runs/{runId}',
      '/v1/workspaces/{workspaceId}/runs/{runId}/events',
      '/v1/workspaces/{workspaceId}/runs/{runId}/cancel',
      '/v1/workspaces/{workspaceId}/runs/{runId}/replay',
    ]);
    const start =
      workflowRunsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs'
      ].post;
    expect(start.responses['202']).toBeDefined();
    expect(start.parameters.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'x-csrf-token']),
    );
    const stream =
      workflowRunsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/runs/{runId}/events'
      ].get;
    expect(stream.parameters.map(({ name }) => name)).toContain(
      'Last-Event-ID',
    );
    expect(stream.responses['200'].content).toHaveProperty('text/event-stream');
    expect(workflowRunsClientContract.schemas).not.toHaveProperty(
      'WorkflowCheckpoint',
    );
  });

  it('bounds run-history filters and enforces an inclusive/exclusive date range', () => {
    const parsed = workflowRunListQuerySchema.parse({
      limit: '100',
      status: 'succeeded',
      createdAtFrom: '2026-08-20T00:00:00.000Z',
      createdAtBefore: '2026-08-21T00:00:00.000Z',
    });
    expect(parsed.limit).toBe(100);
    expect(parsed.createdAtFrom).toBe('2026-08-20T00:00:00.000000Z');
    expect(
      workflowRunListQuerySchema.parse({ workflowNamePrefix: '  Ops  ' }),
    ).toEqual({ workflowNamePrefix: 'Ops' });
    expect(workflowRunListQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      workflowRunListQuerySchema.safeParse({
        createdAtFrom: '2026-08-21T00:00:00.000Z',
        createdAtBefore: '2026-08-21T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      workflowRunListQuerySchema.safeParse({ status: 'not-a-status' }).success,
    ).toBe(false);
    expect(
      workflowRunListQuerySchema.parse({
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      }),
    ).toEqual({
      createdAtFrom: '2026-08-21T00:00:00.000100Z',
      createdAtBefore: '2026-08-21T00:00:00.000900Z',
    });
    expect(
      workflowRunListQuerySchema.safeParse({
        createdAtFrom: '2026-08-21T00:00:00.0000001Z',
      }).success,
    ).toBe(false);
  });

  it('exposes current workflow names on read projections', () => {
    const summary = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      workflowName: null,
      status: 'succeeded',
      triggerType: 'manual',
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
      deadlineAt: null,
      cancelRequestedAt: null,
    };
    expect(
      workflowRunListResponseSchema.parse({
        items: [summary],
        nextCursor: null,
      }).items[0]?.workflowName,
    ).toBeNull();
  });
});
