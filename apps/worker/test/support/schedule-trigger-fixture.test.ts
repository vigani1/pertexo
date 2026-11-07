import type { WorkflowAuthoringStoreOptions } from '@pertexo/core/testing';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import { createScheduleTriggerFixture } from './schedule-trigger-fixture.js';

const scheduleGraph: WorkflowGraph = {
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

function admission(fixture: ReturnType<typeof createScheduleTriggerFixture>) {
  const options: WorkflowAuthoringStoreOptions =
    fixture.authoringOptions.databaseOptions;
  return options.validateAuthoringGraph;
}

describe('Schedule fixture authoring admission ownership', () => {
  it('compiles the supported schedule and refuses a version outside its catalog', async () => {
    const fixture = createScheduleTriggerFixture({});
    try {
      const compile =
        fixture.authoringOptions.databaseOptions.executableCompiler;
      const compiled = compile(scheduleGraph);
      expect(typeof compiled.checksum).toBe('string');
      expect(compiled.executableJson).toBeDefined();
      const schedule = scheduleGraph.nodes[0];
      if (schedule === undefined) throw new Error('Schedule node is missing');
      expect(() =>
        compile({
          ...scheduleGraph,
          nodes: [
            { ...schedule, definition: { key: 'core.schedule', version: 999 } },
          ],
        }),
      ).toThrow();
    } finally {
      await fixture.close();
    }
  });

  it('rejects malformed expressions through the real restricted parser', async () => {
    const fixture = createScheduleTriggerFixture({});
    try {
      const validate = admission(fixture);
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
    const validate = admission(fixture);
    try {
      expect(validate).toBeTypeOf('function');
      if (validate === undefined) throw new Error('Admission is not wired');
      const controller = new AbortController();
      controller.abort();
      await expect(
        validate(scheduleGraph, { signal: controller.signal }),
      ).rejects.toMatchObject({ reason: 'canceled' });
      const report = await validate(scheduleGraph, {});
      expect(report.ok).toBe(true);
      expect(report.issues).toEqual([]);
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
    const validate = admission(fixture);
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
