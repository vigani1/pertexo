import type { WorkflowAuthoringDatabaseOptions } from '@pertexo/database/testing';
import { platformExecutableRegistryHistory } from '@pertexo/node-catalog';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/authoring-validation';
import type { WorkflowGraph } from '@pertexo/workflow-model/graph';
import { describe, expect, it, vi } from 'vitest';

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
  it('forwards every retained release policy and command through the same fixture owner', async () => {
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
      const releases = platformExecutableRegistryHistory();
      const command = { signal: new AbortController().signal };
      expect(releases.length).toBeGreaterThan(0);
      expect(variants(fixture)).toHaveLength(releases.length);
      for (const [index, variant] of variants(fixture).entries()) {
        expect(variant.validateAuthoringGraph).toBeTypeOf('function');
        if (variant.validateAuthoringGraph === undefined)
          throw new Error('Schedule authoring admission is not wired');
        const release = releases[index];
        if (release === undefined)
          throw new Error('Retained release is missing');
        const fingerprint =
          composeExecutableCompatibilityRelease(release).fingerprint;
        expect(variant.compatibilityRelease.fingerprint).toBe(fingerprint);
        await variant.validateAuthoringGraph(scheduleGraph, command);
        expect(validate).toHaveBeenLastCalledWith(
          scheduleGraph,
          {
            releaseFingerprint: fingerprint,
            definitions: release.definitions.map((manifest) => ({
              definition: {
                key: manifest.definition.key,
                version: manifest.definition.version,
              },
              policyReferences: manifest.policyReferences.map(
                ({ key, version }) => ({
                  key,
                  version,
                }),
              ),
            })),
          },
          command,
        );
        expect(validate.mock.lastCall?.[0]).toBe(scheduleGraph);
        expect(validate.mock.lastCall?.[2]).toBe(command);
        expect(validate.mock.lastCall?.[2]?.signal).toBe(command.signal);
      }
      expect(validate).toHaveBeenCalledTimes(releases.length);
      expect(new Set(validate.mock.contexts).size).toBe(1);
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
