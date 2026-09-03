import { describe, expect, it } from 'vitest';

import { workflowTriggerProjection } from '../src/triggers/workflow-trigger-projection.js';

const node = (
  id: string,
  key: string,
  config: unknown,
): Record<string, unknown> => ({
  id,
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});

describe('workflow trigger projection', () => {
  it('extracts and deterministically fingerprints supported trigger configs', () => {
    const graph = {
      schemaVersion: 1,
      settings: {},
      nodes: [
        node('webhook', 'core.webhook', {}),
        node('schedule', 'core.schedule', {
          kind: 'cron',
          expression: '0 9 * * 1',
          timezone: 'Europe/Zurich',
          misfirePolicy: 'catch_up_once',
        }),
        node('action', 'core.http', {}),
      ],
      edges: [],
    };

    expect(workflowTriggerProjection(graph)).toEqual([
      {
        nodeId: 'schedule',
        kind: 'schedule',
        config: {
          kind: 'cron',
          expression: '0 9 * * 1',
          timezone: 'Europe/Zurich',
          misfirePolicy: 'catch_up_once',
        },
        configFingerprint:
          'trigger:v1:sha256:e50092841959403af8b803ab3e204eac6e29abbc6b7ed3767cc8d19664c91dec',
      },
      {
        nodeId: 'webhook',
        kind: 'webhook',
        config: {},
        configFingerprint:
          'trigger:v1:sha256:66cb4e52e056167906bf8f6e7d44e56247048bfd9af9644f9ad73bb288af138c',
      },
    ]);
  });

  it('rejects trigger config outside the published contracts', () => {
    expect(() =>
      workflowTriggerProjection({
        schemaVersion: 1,
        settings: {},
        nodes: [node('webhook', 'core.webhook', { secret: 'not-graph-state' })],
        edges: [],
      }),
    ).toThrow();
    expect(() =>
      workflowTriggerProjection({
        schemaVersion: 1,
        settings: {},
        nodes: [
          node('schedule', 'core.schedule', {
            kind: 'interval',
            intervalMinutes: 0,
            misfirePolicy: 'skip',
          }),
        ],
        edges: [],
      }),
    ).toThrow();
  });
});
