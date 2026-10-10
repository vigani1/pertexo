import type { WorkflowAuthoringDatabaseOptions } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/server';
import { describe, expect, it, vi } from 'vitest';

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
  const options: WorkflowAuthoringDatabaseOptions =
    fixture.authoringOptions.databaseOptions;
  return options.validateAuthoringGraph;
}

describe('Schedule fixture authoring admission ownership', () => {
  it('forwards the catalog policies and command through the same fixture owner', async () => {
    const fixture = createScheduleTriggerFixture({});
    const validate = vi
      .spyOn(WorkflowAuthoringValidator.prototype, 'validate')
      .mockResolvedValue({
        ok: true,
        issues: [],
        expandedInvocations: 0,
        worstCaseLoopIterations: 0,
      });
    try {
      const command = { signal: new AbortController().signal };
      const validateAuthoringGraph = admission(fixture);
      if (validateAuthoringGraph === undefined)
        throw new Error('Schedule authoring admission is not wired');
      await validateAuthoringGraph(scheduleGraph, command);
      expect(validate).toHaveBeenLastCalledWith(
        scheduleGraph,
        {
          definitions: PLATFORM_NODE_CATALOG.definitions.map((manifest) => ({
            definition: {
              key: manifest.definition.key,
              version: manifest.definition.version,
            },
            policyReferences: manifest.policyReferences.map(
              ({ key, version }) => ({ key, version }),
            ),
          })),
        },
        command,
      );
      expect(validate.mock.lastCall?.[0]).toBe(scheduleGraph);
      expect(validate.mock.lastCall?.[2]).toBe(command);
      expect(validate).toHaveBeenCalledOnce();
      expect(validate.mock.contexts[0]).toBeInstanceOf(
        WorkflowAuthoringValidator,
      );
    } finally {
      try {
        await fixture.close();
      } finally {
        validate.mockRestore();
      }
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
