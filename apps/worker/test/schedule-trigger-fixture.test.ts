import type { WorkflowAuthoringDatabaseOptions } from '@pertexo/database/testing';
import type { WorkflowGraph } from '@pertexo/workflow-model/graph';
import { describe, expect, it } from 'vitest';

import { createScheduleTriggerFixture } from './support/schedule-trigger-fixture.js';

const scheduleGraph: WorkflowGraph = {
  schemaVersion: 1,
  settings: {},
  nodes: [
    {
      id: 'schedule',
      definition: { key: 'core.schedule', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {
        kind: 'interval',
        intervalMinutes: 1,
        misfirePolicy: 'catch_up_once',
      },
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
};

function variants(fixture: ReturnType<typeof createScheduleTriggerFixture>) {
  const options: WorkflowAuthoringDatabaseOptions =
    fixture.authoringOptions.databaseOptions;
  return options.compatibilityReleaseVariants ?? [];
}

describe('Schedule fixture authoring admission ownership', () => {
  it('wires every retained release to real authoring validation without service setup', async () => {
    const fixture = createScheduleTriggerFixture({});
    try {
      expect(variants(fixture).length).toBeGreaterThan(0);
      for (const variant of variants(fixture)) {
        expect(variant.validateAuthoringGraph).toBeTypeOf('function');
        if (variant.validateAuthoringGraph === undefined)
          throw new Error('Schedule authoring admission is not wired');
        const report = await variant.validateAuthoringGraph(scheduleGraph, {});
        expect(report.ok).toBe(true);
        expect(report.issues).toEqual([]);
      }
    } finally {
      await fixture.close();
    }
  });

  it('rejects malformed expressions through the real restricted parser', async () => {
    const fixture = createScheduleTriggerFixture({});
    try {
      const validate = variants(fixture).at(-1)?.validateAuthoringGraph;
      expect(validate).toBeTypeOf('function');
      if (validate === undefined) throw new Error('Admission is not wired');
      const schedule = scheduleGraph.nodes[0];
      if (schedule === undefined) throw new Error('Schedule node is missing');
      const graph: WorkflowGraph = {
        ...scheduleGraph,
        nodes: [
          {
            ...schedule,
            id: 'set',
            definition: { key: 'core.set', version: 1 },
            config: {},
            inputMappings: {
              result: {
                kind: 'expression',
                language: 'jsonata',
                policyVersion: 1,
                expression: '(',
              },
            },
          },
        ],
      };
      const report = await validate(graph, {});
      expect(report.ok).toBe(false);
      expect(report.issues).toContainEqual({
        code: 'invalid_expression',
        path: '$.nodes.set.inputMappings.result',
        message: 'This expression is not valid restricted JSONata.',
      });
    } finally {
      await fixture.close();
    }
  });

  it('preserves cancellation and closes the admission owner idempotently', async () => {
    const fixture = createScheduleTriggerFixture({});
    const validate = variants(fixture).at(-1)?.validateAuthoringGraph;
    try {
      expect(validate).toBeTypeOf('function');
      if (validate === undefined) throw new Error('Admission is not wired');
      const controller = new AbortController();
      controller.abort();
      await expect(
        validate(scheduleGraph, { signal: controller.signal }),
      ).rejects.toMatchObject({ reason: 'canceled' });
      await validate(scheduleGraph, {});
      const closing = fixture.close();
      expect(fixture.close()).toBe(closing);
      expect(() => validate(scheduleGraph, {})).toThrow(
        expect.objectContaining({ reason: 'closed' }),
      );
      await closing;
    } finally {
      await fixture.close();
    }
  });

  it('does not acquire an admission worker after a never-started fixture closes', async () => {
    const fixture = createScheduleTriggerFixture({});
    const validate = variants(fixture).at(-1)?.validateAuthoringGraph;
    const closing = fixture.close();
    try {
      expect(validate).toBeTypeOf('function');
      if (validate === undefined) throw new Error('Admission is not wired');
      expect(() => validate(scheduleGraph, {})).toThrow(
        expect.objectContaining({ reason: 'closed' }),
      );
      expect(fixture.close()).toBe(closing);
    } finally {
      await closing;
    }
  });
});
