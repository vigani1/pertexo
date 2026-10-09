import { describe, expect, it } from 'vitest';

import { usageCapacityResponseSchema } from '../src/schemas/workflow-runs.js';
import { workflowRunsOpenApiDocument } from '../src/server.js';

const capacity = {
  asOf: '2026-10-01T12:00:00.123456Z',
  execution: {
    activeRuns: 2,
    reservedActiveSlots: 1,
    activeCapacityConsumed: 3,
    queuedRuns: 4,
    policy: {
      state: 'active',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    },
  },
  artifacts: {
    chargedBytes: '9007199254740993',
    byteLimit: '9223372036854775807',
    chargedCount: 4,
    artifactCountLimit: 1000,
    source: 'stored',
  },
};

describe('workspace capacity contract', () => {
  it('preserves exact bytes beyond JavaScript safe integer range', () => {
    expect(
      usageCapacityResponseSchema.parse(capacity).artifacts.chargedBytes,
    ).toBe('9007199254740993');
  });

  it('distinguishes unavailable execution limits from zero artifact limits', () => {
    const result = usageCapacityResponseSchema.parse({
      ...capacity,
      execution: {
        ...capacity.execution,
        policy: {
          state: 'unavailable',
          version: null,
          activeRunLimit: null,
          queuedRunLimit: null,
        },
      },
      artifacts: {
        ...capacity.artifacts,
        byteLimit: '0',
        artifactCountLimit: 0,
      },
    });
    expect(result.execution.policy.activeRunLimit).toBeNull();
    expect(result.artifacts.byteLimit).toBe('0');
  });

  it.each(['-1', '01', '1.5', '1e3', ' 1', '12345678901234567890'])(
    'rejects noncanonical bytes %s',
    (chargedBytes) => {
      expect(
        usageCapacityResponseSchema.safeParse({
          ...capacity,
          artifacts: { ...capacity.artifacts, chargedBytes },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects rounded numeric byte representations and undeclared billing data', () => {
    expect(
      usageCapacityResponseSchema.safeParse({
        ...capacity,
        artifacts: { ...capacity.artifacts, chargedBytes: 42 },
      }).success,
    ).toBe(false);
    expect(
      usageCapacityResponseSchema.safeParse({
        ...capacity,
        billedOperations: 0,
      }).success,
    ).toBe(false);
  });

  it('publishes an authenticated read-only contract without time or quota commands', () => {
    const path =
      workflowRunsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/usage-capacity'
      ];
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get.security).toEqual([{ cookieSession: [] }]);
    expect(path.get.parameters.map((parameter) => parameter.name)).toEqual([
      'workspaceId',
    ]);
  });
});
