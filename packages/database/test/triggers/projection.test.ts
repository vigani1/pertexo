import { describe, expect, it } from 'vitest';

import { workflowTriggerProjection } from '../../src/triggers/reconciliation/projection.js';

const node = (
  id: string,
  key: string,
  config: unknown,
  version = 1,
): Record<string, unknown> => ({
  id,
  definition: { key, version },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});

describe('workflow trigger projection', () => {
  it('extracts and deterministically fingerprints supported trigger configs', () => {
    const graph = {
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
          'trigger:sha256:e50092841959403af8b803ab3e204eac6e29abbc6b7ed3767cc8d19664c91dec',
      },
      {
        nodeId: 'webhook',
        kind: 'webhook',
        config: {},
        configFingerprint:
          'trigger:sha256:66cb4e52e056167906bf8f6e7d44e56247048bfd9af9644f9ad73bb288af138c',
      },
    ]);
  });

  it('projects strict Schedule definitions for reconciliation', () => {
    const projected = workflowTriggerProjection({
      settings: {},
      nodes: [
        node('schedule', 'core.schedule', {
          kind: 'cron',
          expression: '0 9 * * 1',
          timezone: 'Europe/Zurich',
          misfirePolicy: 'skip',
        }),
      ],
      edges: [],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        nodeId: 'schedule',
        kind: 'schedule',
      }),
    ]);
    expect(() =>
      workflowTriggerProjection({
        settings: {},
        nodes: [
          node('schedule', 'core.schedule', {
            kind: 'cron',
            expression: '0 9 * * 1',
            timezone: 'Etc/GMT+1',
            misfirePolicy: 'skip',
          }),
        ],
        edges: [],
      }),
    ).toThrow();
  });

  it('rejects an oversized Schedule recurrence before materialization', () => {
    const expression = `${Array(150).fill('0').join(',')} * * * *`;
    expect(() =>
      workflowTriggerProjection({
        settings: {},
        nodes: [
          node('oversized', 'core.schedule', {
            kind: 'cron',
            expression,
            timezone: 'Europe/Paris',
            misfirePolicy: 'skip',
          }),
        ],
        edges: [],
      }),
    ).toThrow();
  });

  it.each([
    ['webhook', 'core.webhook', 1, {}],
    [
      'schedule',
      'core.schedule',
      1,
      {
        kind: 'interval',
        intervalMinutes: 5,
        misfirePolicy: 'catch_up_once',
      },
    ],
  ] as const)(
    'treats graph-disabled %s as execution-only external trigger state',
    (id, key, version, config) => {
      const projections = [undefined, false, true].map((disabled) => {
        const triggerNode = node(id, key, config, version);
        if (disabled !== undefined) triggerNode.disabled = disabled;
        return workflowTriggerProjection({
          settings: {},
          nodes: [triggerNode],
          edges: [],
        });
      });

      expect(projections[1]).toEqual(projections[0]);
      expect(projections[2]).toEqual(projections[0]);
      expect(projections[0]).toHaveLength(1);
    },
  );

  it('rejects trigger config outside the published contracts', () => {
    expect(() =>
      workflowTriggerProjection({
        settings: {},
        nodes: [node('webhook', 'core.webhook', { secret: 'not-graph-state' })],
        edges: [],
      }),
    ).toThrow();
    expect(() =>
      workflowTriggerProjection({
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
