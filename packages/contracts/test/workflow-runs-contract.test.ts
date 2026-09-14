import { describe, expect, it } from 'vitest';

import {
  workflowRunCancelRequestSchema,
  workflowRunReplayRequestSchema,
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
});
